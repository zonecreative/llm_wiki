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
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

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

install: ## Install dependencies
	npm install
	@echo "Dependencies installed."

mcp-build: ## Build the MCP server (required before tauri dev)
	npm run mcp:build
