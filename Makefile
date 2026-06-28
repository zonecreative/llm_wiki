# llm_wiki — Development commands
#
# Usage:
#   make help          — show all commands
#   make kill          — kill processes holding the app ports + stale tauri dev
#   make dev           — kill stale processes then start tauri dev
#   make clean-dev     — kill + clean caches + start fresh dev
#   make test          — run all mock tests
#   make test-watch    — run tests in watch mode
#   make typecheck     — TypeScript type check
#   make check         — typecheck + tests (pre-commit safety net)
#   make clean-caches  — remove ingest cache, long-source checkpoints, graphify
#   make graphify      — rebuild the knowledge graph
#   make build         — production build (typecheck + vite build)

.PHONY: help kill dev clean-dev test test-watch typecheck check clean-caches graphify build

# Ports used by the app
APP_PORTS := 19828 19827 1420 5173

help: ## Show available commands
	@echo ""
	@echo "  llm_wiki — Development Commands"
	@echo ""
	@echo "  Make                          npm                          Description"
	@echo "  ─────────────────────────────────────────────────────────────────────"
	@echo "  make help                     —                            Show this help"
	@echo "  make kill                     npm run kill                 Kill processes on app ports + stale tauri/vite"
	@echo "  make dev                      npm run tauri dev            Kill stale processes then start tauri dev"
	@echo "  make clean-dev                npm run dev:clean            Kill + clean caches + start fresh dev"
	@echo "  make test                     npm run test:mocks           Run all mock tests"
	@echo "  make test-watch               npm run test:watch           Run tests in watch mode"
	@echo "  make test-fast FILE=…         —                            Run a specific test file"
	@echo "  make test-llm                 npm run test:llm             Run real-LLM tests (needs Ollama/API key)"
	@echo "  make typecheck                npm run typecheck            TypeScript type check"
	@echo "  make check                    npm run check                Typecheck + tests (run before commit)"
	@echo "  make clean-caches             —                            Remove ingest cache, checkpoints, graphify data"
	@echo "  make clean-project-cache      —                            Clean caches for a specific project (PATH=…)"
	@echo "  make graphify                 —                            Rebuild the knowledge graph"
	@echo "  make build                    npm run build                Production build (typecheck + vite build)"
	@echo "  make release                  npm run release              Build release .app + install to /Applications"
	@echo "  make release-dmg               —                            Build .dmg installer for distribution"
	@echo "  make install                  npm install                  Install dependencies"
	@echo "  make mcp-build                npm run mcp:build            Build the MCP server (before tauri dev)"
	@echo ""
	@echo "  Tips"
	@echo "  • Run 'make kill' before 'make dev' if you see 'Address already in use'"
	@echo "  • Set outputLanguage: Italian in Settings to avoid auto-detect misdetections"
	@echo "  • Use 'make clean-project-cache PATH=/path/to/project' to force re-ingest of one project"
	@echo ""

kill: ## Kill processes holding app ports + stale tauri dev
	@echo "Killing processes on ports: $(APP_PORTS)"
	@for port in $(APP_PORTS); do \
		pid=$$(lsof -ti:$$port 2>/dev/null); \
		if [ -n "$$pid" ]; then \
			echo "  Port $$port → PID $$pid → killing"; \
			kill -9 $$pid 2>/dev/null || true; \
		fi; \
	done
	@# Kill stale tauri dev processes
	@pkill -f "tauri dev" 2>/dev/null || true
	@pkill -f "cargo-tauri" 2>/dev/null || true
	@# Kill stale vite processes that might hold port 1420/5173
	@pkill -f "vite.*llm.wiki" 2>/dev/null || true
	@echo "Done."

dev: kill ## Kill stale processes then start tauri dev
	npm run tauri dev

clean-dev: kill clean-caches ## Kill + clean caches + start fresh dev
	npm run tauri dev

test: ## Run all mock tests
	npm run test:mocks

test-watch: ## Run tests in watch mode
	npx vitest --exclude='**/*.real-llm.test.ts' --exclude='**/mcp-server/**'

test-fast: ## Run a specific test file (usage: make test-fast FILE=src/lib/heading-parser.test.ts)
	npm run test:mocks -- $(FILE)

test-llm: ## Run real-LLM tests (needs Ollama or API key)
	npm run test:llm

typecheck: ## TypeScript type check
	npm run typecheck

check: typecheck test ## Typecheck + tests (run before commit)

clean-caches: ## Remove ingest cache, checkpoints, graphify data
	@echo "Cleaning caches..."
	@find . -path './node_modules' -prune -o -name 'ingest-cache.json' -print -exec rm -f {} + 2>/dev/null || true
	@find . -path './node_modules' -prune -o -type d -name 'ingest-progress' -print -exec rm -rf {} + 2>/dev/null || true
	@find . -path './node_modules' -prune -o -name '.llm-wiki' -type d -exec rm -rf {} + 2>/dev/null || true
	@rm -rf graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/graph.html 2>/dev/null || true
	@echo "Caches cleaned."

clean-project-cache: ## Clean caches for a specific project (usage: make clean-project-cache PATH=/path/to/project)
	@echo "Cleaning caches for: $(PATH)"
	@rm -rf "$(PATH)/.llm-wiki/ingest-cache.json" 2>/dev/null || true
	@rm -rf "$(PATH)/.llm-wiki/ingest-progress" 2>/dev/null || true
	@echo "Project caches cleaned."

graphify: ## Rebuild the knowledge graph
	@echo "Rebuilding knowledge graph..."
	@graphify . 2>/dev/null || python3 -m graphify . 2>/dev/null || echo "graphify not installed. Install with: pip install graphifyy"
	@echo "Graph rebuilt in graphify-out/"

build: ## Production build (typecheck + vite build)
	npm run build

release: ## Build release .app bundle and install to /Applications
	@echo "Building release .app bundle..."
	npm run tauri build
	@echo "Installing to /Applications..."
	@APP_PATH=$$(find src-tauri/target/release/bundle/macos -name "*.app" -maxdepth 1 2>/dev/null | head -1); \
	if [ -z "$$APP_PATH" ]; then \
		echo "ERROR: no .app found in src-tauri/target/release/bundle/macos/"; \
		echo "Check build output above for errors."; \
		exit 1; \
	fi; \
	APP_NAME=$$(basename "$$APP_PATH"); \
	echo "Found: $$APP_PATH"; \
	if [ -d "/Applications/$$APP_NAME" ]; then \
		echo "Removing old version from /Applications..."; \
		rm -rf "/Applications/$$APP_NAME"; \
	fi; \
	cp -R "$$APP_PATH" /Applications/; \
	echo ""; \
	echo "✓ Installed to /Applications/$$APP_NAME"; \
	echo "  Open with: open /Applications/$$APP_NAME"; \
	echo "  Or find it in Launchpad / Spotlight"

release-dmg: ## Build release .dmg installer (for distribution)
	@echo "Building release .dmg installer..."
	npm run tauri build -- --bundles dmg
	@DMG_PATH=$$(find src-tauri/target/release/bundle/dmg -name "*.dmg" -maxdepth 1 2>/dev/null | head -1); \
	if [ -n "$$DMG_PATH" ]; then \
		echo ""; \
		echo "✓ DMG created: $$DMG_PATH"; \
		echo "  Double-click to install, or distribute to others."; \
	else \
		echo "No .dmg found — check build output."; \
	fi

install: ## Install dependencies
	npm install
	@echo "Dependencies installed."

mcp-build: ## Build the MCP server (required before tauri dev)
	npm run mcp:build
