# Shortcuts around the npm scripts. `make start` is the one you want.

PORT ?= 5178

.DEFAULT_GOAL := help
.PHONY: help start dev build stop check install archive install-archive-agent install-statusline

help: ## List targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}'

start: install build ## Build the UI, serve it from the API on :5178, open a browser
	@echo "→ http://127.0.0.1:$(PORT)"
# Poll until the port answers, then open — a fixed sleep either races the
# build-cold start or wastes a second. Bounded, so a failed boot doesn't spin.
	@( for i in $$(seq 1 60); do \
	     curl -sfo /dev/null http://127.0.0.1:$(PORT)/ && break || sleep 0.25; \
	   done; \
	   command -v open >/dev/null && open http://127.0.0.1:$(PORT) \
	     || xdg-open http://127.0.0.1:$(PORT) >/dev/null 2>&1 ) &
	@PORT=$(PORT) node server/index.mjs

dev: install ## Hot-reloading UI on :5179, API on :5178
	@npm run dev

build: install ## Build the UI into dist/
	@npm run build

check: install ## Typecheck (there is no test suite yet)
	@npx tsc --noEmit

archive: ## Digest new transcripts into the archive before Claude Code deletes them
	@node server/archive.mjs

install-archive-agent: ## Run `make archive` daily via a macOS LaunchAgent (re-run after a Node upgrade)
	@./scripts/install-archive-agent.sh

install-statusline: ## Install the Claude Code statusline that writes the .claude-costs ledgers
	@./scripts/install-statusline.sh

stop: ## Kill a server left running in the background
	@pkill -f 'node server/index.mjs' && echo "stopped" || echo "nothing running"

# Only reinstall when package.json is newer than the tree npm last wrote.
install: node_modules
node_modules: package.json
	@npm install
	@touch node_modules
