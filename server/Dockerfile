# syntax=docker/dockerfile:1

# please note that this Dockerfile has not be tested in an acctual production environment, and is provided as a reference 
# for those who want to run scratchcad on a server. It is not guaranteed to be secure or performant, and should be used at your own risk.
# Please open an issue or PR if this Dockerfile does not work for you, or if you have suggestions for improvements.

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
 && cp target/release/scratchcad /scratchcad

# Distroless: glibc + libgcc only, no shell, runs as uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /scratchcad /usr/local/bin/scratchcad
ENV SCRATCHCAD_LISTEN=0.0.0.0:8080 \
    SCRATCHCAD_LOG_FORMAT=json
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/scratchcad"]
