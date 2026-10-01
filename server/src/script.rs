//! Sandboxed Rhai execution.
//!
//! Scripts use Fidget's Rhai bindings and produce a shape either by calling
//! `draw(shape)` exactly once or by evaluating to a shape as their final
//! expression.  The resulting math graph is returned as a Fidget
//! [`Context`] + root [`Node`]; nothing is retained between requests.

use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use fidget::{
    context::{Context, Node, Tree},
    eval::Function,
    render::CancelToken,
    rhai::FromDynamic,
    var::Var,
};
use rhai::{Dynamic, EvalAltResult, NativeCallContext};

use crate::error::ApiError;

/// Maximum captured `print` / `debug` lines per script
const MAX_OUTPUT_LINES: usize = 100;
/// Maximum length of a single captured output line
const MAX_OUTPUT_LINE_LEN: usize = 1024;

#[derive(Debug, Clone, Copy)]
pub struct ScriptLimits {
    pub max_operations: u64,
    pub max_nodes: usize,
    pub max_string_size: usize,
}

/// A script that has been executed and reduced to a math graph
pub struct Compiled {
    pub ctx: Context,
    pub root: Node,
    /// Number of unique nodes in the math graph
    pub nodes: usize,
    /// Captured `print` / `debug` output
    pub output: Vec<String>,
    /// Time spent executing the script, in milliseconds
    pub compile_ms: f64,
}

/// Builds a Rhai engine with Fidget bindings and sandbox limits applied
fn engine(
    limits: &ScriptLimits,
    cancel: CancelToken,
    output: Arc<Mutex<Vec<String>>>,
) -> rhai::Engine {
    let mut engine = fidget::rhai::engine();

    // Resource limits.  `fidget::rhai::engine` installs its own `on_progress`
    // step limit; we replace it with a configurable operation cap plus a
    // cancellation check so that timeouts interrupt long-running scripts.
    engine.set_max_operations(limits.max_operations);
    engine.on_progress(move |_| {
        cancel
            .is_cancelled()
            .then(|| Dynamic::from("script cancelled"))
    });
    engine.set_max_call_levels(64);
    engine.set_max_expr_depths(64, 32);
    engine.set_max_string_size(limits.max_string_size);
    engine.set_max_array_size(100_000);
    engine.set_max_map_size(10_000);
    engine.set_max_variables(10_000);
    engine.set_max_functions(1_000);

    // No filesystem access through `import`, and no dynamic `eval`.
    engine.set_max_modules(0);
    engine.set_module_resolver(rhai::module_resolvers::DummyModuleResolver::new());
    engine.disable_symbol("eval");

    // Capture output instead of writing to the server's stdout.
    let out = output.clone();
    engine.on_print(move |s| push_line(&out, s.to_owned()));
    engine.on_debug(move |s, _src, pos| {
        push_line(&output, format!("[{pos}] {s}"));
    });
    engine
}

fn push_line(out: &Mutex<Vec<String>>, mut s: String) {
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    if out.len() < MAX_OUTPUT_LINES {
        if s.len() > MAX_OUTPUT_LINE_LEN {
            let mut end = MAX_OUTPUT_LINE_LEN;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
            s.push('…');
        }
        out.push(s);
    }
}

/// Executes a script and reduces it to a math graph
pub fn compile(
    src: &str,
    limits: &ScriptLimits,
    cancel: &CancelToken,
) -> Result<Compiled, ApiError> {
    let start = Instant::now();
    let output = Arc::new(Mutex::new(vec![]));
    let mut engine = engine(limits, cancel.clone(), output.clone());

    let drawn: Arc<Mutex<Option<Tree>>> = Arc::default();
    let drawn_ = drawn.clone();
    engine.register_fn(
        "draw",
        move |ctx: NativeCallContext, d: Dynamic| -> Result<(), Box<EvalAltResult>> {
            let t = Tree::from_dynamic(&ctx, d, None)?;
            let mut slot = drawn_.lock().unwrap_or_else(|e| e.into_inner());
            if slot.is_some() {
                return Err("draw() may only be called once".into());
            }
            *slot = Some(t);
            Ok(())
        },
    );

    let ast = engine
        .compile(src)
        .map_err(|e| ApiError::Script(e.to_string()))?;
    let result = engine
        .eval_ast::<Dynamic>(&ast)
        .map_err(|e| map_eval_error(*e, limits, cancel))?;

    let tree = match drawn.lock().unwrap_or_else(|e| e.into_inner()).take() {
        Some(t) => t,
        None => {
            let got = result.type_name();
            result.try_cast::<Tree>().ok_or_else(|| {
                ApiError::Script(format!(
                    "script must call draw(shape) or evaluate to a shape, \
                     but it evaluated to a value of type `{got}`"
                ))
            })?
        }
    };
    // Release the engine (and its closures) before the potentially large
    // import, so that the only remaining reference to the tree is ours.
    drop(engine);

    let mut ctx = Context::new();
    let root = ctx.import(&tree);
    drop(tree);

    let nodes = ctx.len();
    if nodes > limits.max_nodes {
        return Err(ApiError::LimitExceeded(format!(
            "shape has {nodes} nodes; the limit is {}",
            limits.max_nodes
        )));
    }
    check_vars(&ctx, root)?;

    let output = std::mem::take(&mut *output.lock().unwrap_or_else(|e| e.into_inner()));
    Ok(Compiled {
        ctx,
        root,
        nodes,
        output,
        compile_ms: start.elapsed().as_secs_f64() * 1e3,
    })
}

/// Rejects shapes that depend on free variables other than `x`, `y`, `z`,
/// which the rendering endpoints have no way to bind.
fn check_vars(ctx: &Context, root: Node) -> Result<(), ApiError> {
    // Only the graph the script produced can make this fail, so the error
    // belongs to the caller rather than the server.
    let shape = fidget::vm::VmShape::new(ctx, root)
        .map_err(|e| ApiError::Unprocessable(format!("could not build the shape: {e}")))?;
    let free = shape
        .inner()
        .vars()
        .iter()
        .filter(|(v, _)| !matches!(v, Var::X | Var::Y | Var::Z))
        .count();
    if free > 0 {
        return Err(ApiError::Unprocessable(format!(
            "shape uses {free} free variable(s) other than x, y and z; \
             only x, y and z can be bound when it is evaluated"
        )));
    }
    Ok(())
}

fn map_eval_error(e: EvalAltResult, limits: &ScriptLimits, cancel: &CancelToken) -> ApiError {
    match e {
        EvalAltResult::ErrorTerminated(..) if cancel.is_cancelled() => ApiError::cancelled(),
        EvalAltResult::ErrorTooManyOperations(pos) => {
            let at = if pos.is_none() {
                String::new()
            } else {
                format!(" at {pos}")
            };
            ApiError::LimitExceeded(format!(
                "script exceeded its budget of {} operations{at}",
                limits.max_operations
            ))
        }
        EvalAltResult::ErrorDataTooLarge(what, pos) => {
            ApiError::LimitExceeded(format!("script exceeded a size limit: {what} ({pos})"))
        }
        EvalAltResult::ErrorStackOverflow(pos) => {
            ApiError::LimitExceeded(format!("script exceeded the call depth limit ({pos})"))
        }
        other => ApiError::Script(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> ScriptLimits {
        ScriptLimits {
            max_operations: 100_000,
            max_nodes: 10_000,
            max_string_size: 4096,
        }
    }

    #[test]
    fn draw_and_expression_forms() {
        let c = CancelToken::new();
        let a = compile("draw(sphere(#{ radius: 1.0 }))", &limits(), &c).unwrap();
        let b = compile("sphere(#{ radius: 1.0 })", &limits(), &c).unwrap();
        assert_eq!(a.nodes, b.nodes);
        assert!(a.nodes > 3);
    }

    #[test]
    fn rejects_non_shapes_and_double_draw() {
        let c = CancelToken::new();
        assert!(matches!(
            compile("1 + 2", &limits(), &c),
            Err(ApiError::Script(_))
        ));
        assert!(matches!(
            compile("draw(x); draw(y)", &limits(), &c),
            Err(ApiError::Script(_))
        ));
    }

    #[test]
    fn non_shape_result_names_what_the_script_produced() {
        let c = CancelToken::new();
        let msg = |src| match compile(src, &limits(), &c) {
            Err(ApiError::Script(m)) => m,
            _ => panic!("expected a script error for {src}"),
        };
        assert!(msg("1 + 2").ends_with("evaluated to a value of type `i64`"));
        assert!(msg("let s = x;").ends_with("evaluated to a value of type `()`"));
    }

    #[test]
    fn operation_budget_error_gives_limit_and_position() {
        let c = CancelToken::new();
        let l = ScriptLimits {
            max_operations: 100,
            ..limits()
        };
        let Err(ApiError::LimitExceeded(m)) = compile("let t = 0;\nloop { t += 1; }", &l, &c)
        else {
            panic!("expected a limit error")
        };
        assert!(m.contains("budget of 100 operations at line 2"), "{m}");
    }

    #[test]
    fn sandbox_limits() {
        let c = CancelToken::new();
        assert!(matches!(
            compile("loop {}", &limits(), &c),
            Err(ApiError::LimitExceeded(_))
        ));
        assert!(matches!(
            compile("import \"/etc/passwd\" as p; x", &limits(), &c),
            Err(ApiError::Script(_))
        ));
        assert!(matches!(
            compile("eval(\"x\")", &limits(), &c),
            Err(ApiError::Script(_))
        ));
        let big = "let t = x; for i in 0..20000 { t = t + i; } t";
        assert!(matches!(
            compile(big, &limits(), &c),
            Err(ApiError::LimitExceeded(_))
        ));
    }

    #[test]
    fn cancellation_interrupts_script() {
        let c = CancelToken::new();
        c.cancel();
        let l = ScriptLimits {
            max_operations: 0, // unlimited
            ..limits()
        };
        assert!(matches!(
            compile("loop {}", &l, &c),
            Err(ApiError::Timeout(_))
        ));
    }

    #[test]
    fn captures_print() {
        let c = CancelToken::new();
        let out = compile("print(\"hi\"); x", &limits(), &c).unwrap();
        assert_eq!(out.output, vec!["hi".to_string()]);
    }

    #[test]
    fn output_is_capped_and_truncated() {
        let c = CancelToken::new();
        let out = compile("for i in 0..150 { print(i) } x", &limits(), &c).unwrap();
        assert_eq!(out.output.len(), MAX_OUTPUT_LINES);
        assert_eq!(out.output[99], "99");

        // Long lines are cut on a char boundary: "é" is two bytes, so 1024
        // bytes falls exactly between characters but 1023 does not.
        let accents = "let s = \"\"; for i in 0..600 { s += \"é\"; }";
        let out = compile(&format!("{accents} print(s); x"), &limits(), &c).unwrap();
        let line = &out.output[0];
        assert!(line.ends_with('…'));
        assert_eq!(line.len(), MAX_OUTPUT_LINE_LEN + '…'.len_utf8());
        let out = compile(&format!("{accents} print(\"a\" + s); x"), &limits(), &c).unwrap();
        assert_eq!(
            out.output[0].len(),
            MAX_OUTPUT_LINE_LEN - 1 + '…'.len_utf8()
        );
    }

    #[test]
    fn debug_output_includes_position() {
        let c = CancelToken::new();
        let out = compile("debug(\"here\"); x", &limits(), &c).unwrap();
        assert!(
            out.output[0].starts_with("[line 1, position 1]"),
            "{:?}",
            out.output
        );
        assert!(out.output[0].contains("here"));
    }

    #[test]
    fn string_size_limit() {
        let c = CancelToken::new();
        let l = ScriptLimits {
            max_string_size: 64,
            ..limits()
        };
        let r = compile("let s = \"a\"; for i in 0..10 { s += s; } x", &l, &c);
        assert!(matches!(r, Err(ApiError::LimitExceeded(m)) if m.contains("size")));
    }

    #[test]
    fn free_variables_are_rejected() {
        let mut ctx = Context::new();
        let x = ctx.x();
        let v = ctx.var(Var::new());
        let root = ctx.add(x, v).unwrap();
        assert!(matches!(
            check_vars(&ctx, root),
            Err(ApiError::Unprocessable(_))
        ));
        assert!(check_vars(&ctx, x).is_ok());
    }

    #[test]
    fn math_constants_and_node_count() {
        let c = CancelToken::new();
        let base = compile("x", &limits(), &c).unwrap().nodes;
        let out = compile("x + PI", &limits(), &c).unwrap();
        // One node for the constant and one for the sum
        assert_eq!(out.nodes, base + 2);
        assert!(out.compile_ms >= 0.0);
        assert!(out.output.is_empty());
    }
}
