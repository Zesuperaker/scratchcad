# syntax=docker/dockerfile:1

FROM rust:1.98-bookworm AS build
WORKDIR /src

# Build dependencies first so they are cached independently of our sources.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && touch src/lib.rs \
 && cargo build --release --locked \
 && rm -rf src

COPY src ./src
RUN touch src/main.rs src/lib.rs \
 && cargo build --release --locked \
 && cp target/release/vibecad /vibecad

# Distroless: glibc + libgcc only, no shell, runs as uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /vibecad /usr/local/bin/vibecad
ENV VIBECAD_LISTEN=0.0.0.0:8080 \
    VIBECAD_LOG_FORMAT=json
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/vibecad"]
