//! Sandboxed Rhai execution and a bounded cache of compiled scripts.
//!
//! Scripts use Fidget's Rhai bindings and produce a shape either by calling
//! `draw(shape)` exactly once or by evaluating to a shape as their final
//! expression.  The resulting math graph is stored as a Fidget [`Context`] +
//! root [`Node`], keyed by the SHA-256 of the script source.

use std::{
    collections::HashMap,
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
use sha2::{Digest, Sha256};

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
    pub id: String,
    pub ctx: Context,
    pub root: Node,
    /// Number of unique nodes in the math graph
    pub nodes: usize,
    /// Captured `print` / `debug` output
    pub output: Vec<String>,
    /// Time spent executing the script, in milliseconds
    pub compile_ms: f64,
}

/// Content-addressed script identifier (lowercase hex SHA-256)
pub fn script_id(src: &str) -> String {
    let digest = Sha256::digest(src.as_bytes());
    let mut s = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Returns `true` if `id` looks like something [`script_id`] would produce
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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
        .map_err(|e| map_eval_error(*e, cancel))?;

    let tree = match drawn.lock().unwrap_or_else(|e| e.into_inner()).take() {
        Some(t) => t,
        None => result.try_cast::<Tree>().ok_or_else(|| {
            ApiError::Script("script must call draw(shape) or evaluate to a shape".into())
        })?,
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
        id: script_id(src),
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
    let shape = fidget::vm::VmShape::new(ctx, root)
        .map_err(|e| ApiError::Internal(format!("building shape: {e}")))?;
    let free = shape
        .inner()
        .vars()
        .iter()
        .filter(|(v, _)| !matches!(v, Var::X | Var::Y | Var::Z))
        .count();
    if free > 0 {
        return Err(ApiError::Unprocessable(format!(
            "shape uses {free} free variable(s) other than x, y, z"
        )));
    }
    Ok(())
}

fn map_eval_error(e: EvalAltResult, cancel: &CancelToken) -> ApiError {
    match e {
        EvalAltResult::ErrorTerminated(..) if cancel.is_cancelled() => ApiError::Timeout,
        EvalAltResult::ErrorTooManyOperations(..) => {
            ApiError::LimitExceeded("script exceeded its operation budget".into())
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

////////////////////////////////////////////////////////////////////////////////

/// Bounded least-recently-used cache of compiled scripts
pub struct ScriptCache {
    capacity: usize,
    inner: Mutex<CacheInner>,
}

#[derive(Default)]
struct CacheInner {
    tick: u64,
    map: HashMap<String, (Arc<Compiled>, u64)>,
}

impl ScriptCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            inner: Mutex::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self, id: &str) -> Option<Arc<Compiled>> {
        let mut inner = self.lock();
        inner.tick += 1;
        let tick = inner.tick;
        inner.map.get_mut(id).map(|(c, t)| {
            *t = tick;
            c.clone()
        })
    }

    pub fn insert(&self, c: Arc<Compiled>) {
        if self.capacity == 0 {
            return;
        }
        let mut inner = self.lock();
        inner.tick += 1;
        let tick = inner.tick;
        if !inner.map.contains_key(&c.id) && inner.map.len() >= self.capacity {
            // O(n) scan; fine for the few hundred entries this cache holds.
            if let Some(oldest) = inner
                .map
                .iter()
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| k.clone())
            {
                inner.map.remove(&oldest);
            }
        }
        inner.map.insert(c.id.clone(), (c, tick));
    }

    pub fn remove(&self, id: &str) -> bool {
        self.lock().map.remove(id).is_some()
    }

    pub fn len(&self) -> usize {
        self.lock().map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
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
        assert!(matches!(compile("loop {}", &l, &c), Err(ApiError::Timeout)));
    }

    #[test]
    fn captures_print() {
        let c = CancelToken::new();
        let out = compile("print(\"hi\"); x", &limits(), &c).unwrap();
        assert_eq!(out.output, vec!["hi".to_string()]);
    }

    #[test]
    fn cache_evicts_lru() {
        let c = CancelToken::new();
        let cache = ScriptCache::new(2);
        let a = Arc::new(compile("x", &limits(), &c).unwrap());
        let b = Arc::new(compile("y", &limits(), &c).unwrap());
        let z = Arc::new(compile("z", &limits(), &c).unwrap());
        cache.insert(a.clone());
        cache.insert(b.clone());
        assert!(cache.get(&a.id).is_some()); // `b` is now least recent
        cache.insert(z.clone());
        assert!(cache.get(&b.id).is_none());
        assert!(cache.get(&a.id).is_some());
        assert!(cache.get(&z.id).is_some());
        assert!(is_valid_id(&a.id));
    }
}
