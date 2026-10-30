## TypeScript and Node.js

- Follow existing repository patterns and use the strictest types practical.
- Avoid `any` and unchecked type assertions; use `unknown` and narrow types instead.
- Validate external input at boundaries; do not rely on TypeScript types at runtime.
- Handle promise rejections and errors explicitly; do not silently swallow failures.
- Use non-blocking APIs for I/O and avoid blocking the event loop.
- Clean up resources such as connections, streams, and timers when their work is complete.
- Use supported Node.js APIs and existing dependencies before adding new packages.