# Contributing to Phage Explorer

Thank you for your interest in contributing to **Phage Explorer**! We welcome contributions from everyone—whether you're fixing a bug, improving documentation, or adding a new feature.

## Getting Started

### Prerequisites

- **Bun**: We use [Bun](https://bun.sh/) as our JavaScript runtime and package manager. Please install it first.
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- **Git**: For version control.

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Dicklesworthstone/phage_explorer.git
   cd phage_explorer
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Build the database**:
   This fetches phage data from NCBI and creates the local SQLite database (`phage.db`).
   ```bash
   bun run build:db
   ```

4. **Run the TUI (Development)**:
   ```bash
   bun run dev
   ```

5. **Run the Web App (Development)**:
   ```bash
   cd packages/web
   bun run dev
   ```

## Project Structure

Phage Explorer is a monorepo managed by Bun Workspaces.

```
phage_explorer/
├── packages/
│   ├── core/           # Shared domain logic (types, biological analysis, theming)
│   ├── tui/            # Terminal User Interface (Ink/React)
│   ├── web/            # Web Application (Vite/React)
│   ├── state/          # Shared State Management (Zustand)
│   ├── db-schema/      # Database Schema (Drizzle)
│   ├── db-runtime/     # Database Runtime (Bun SQLite / SQL.js)
│   ├── data-pipeline/  # Data Ingestion scripts
│   ├── comparison/     # Heavy analysis algorithms (HGT, Synteny)
│   ├── renderer-3d/    # ASCII/Braille 3D Rendering
│   └── wasm-compute/   # Rust/WASM optimization modules
```

## Development Workflow

1. **Create a new branch** for your feature or fix.
   ```bash
   git checkout -b feature/my-awesome-feature
   ```

2. **Check for existing tasks**: We use `bd` (Beads) for issue tracking.
   ```bash
   bd ready
   ```

3. **Make your changes**.
   - Keep logic in `core` or `comparison` if it's shared.
   - Use `state` for global application state.
   - Keep UI components in `tui` or `web` respectively.

4. **Run checks**:
   ```bash
   bun run check  # Runs linting and typechecking
   bun run test   # Runs unit tests
   ```

## Style Guidelines

- **TypeScript**: We use strict mode. No `any` unless absolutely necessary.
- **Formatting**: Code is formatted via ESLint/Prettier rules.
- **Commits**: We follow [Conventional Commits](https://www.conventionalcommits.org/).
  - `feat: add new overlay`
  - `fix: resolve crash in sequence view`
  - `docs: update README`

## Submitting a Pull Request

1. Push your branch to your fork.
2. Open a Pull Request against the `main` branch.
3. Ensure all CI checks pass (Lint, Typecheck, Build).
4. Provide a clear description of your changes.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
