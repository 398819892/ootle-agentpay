# Ootle AgentPay & OTC Escrow — common tasks.
#
# Dev happens on Linux / WSL Ubuntu (the Tari engine's wasmer backend doesn't build on
# Windows). Run these from the repo root inside WSL:  make test | make demo | ...
#
# Override the swarm location if yours isn't the default from docs/devnet.md:
#     make swarm-up SWARM_DIR=/root/ootle/swarm

SHELL      := /bin/bash
PYTHON     ?= python3
TEMPLATES  := escrow agent_budget otc_board

# Local swarm layout (see docs/devnet.md).
SWARM_DIR  ?= /root/ootle/swarm
WALLETD_URL ?= http://127.0.0.1:12010/json_rpc

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@echo "Targets:"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | sort | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- tests
.PHONY: test test-templates test-sdk
test: test-templates test-sdk ## Run all template + SDK tests

test-templates: ## cargo test for all three WASM templates
	@for t in $(TEMPLATES); do \
	  echo "== cargo test: templates/$$t =="; \
	  cargo test --manifest-path templates/$$t/Cargo.toml || exit $$?; \
	done

test-sdk: ## pytest for the ootle-agentpay Python SDK
	cd sdk && $(PYTHON) -m pytest -q

# ---------------------------------------------------------------- local swarm
.PHONY: swarm-up swarm-down
swarm-up: ## Start the local swarm (prebuilt binaries; see docs/devnet.md)
	@test -d "$(SWARM_DIR)/bin" || { echo "No binaries at $(SWARM_DIR)/bin — run 'make fetch-binaries' first."; exit 1; }
	cd "$(SWARM_DIR)/run" && \
	  ../bin/tari_swarm_daemon -c ./config.toml init  --no-compile --binaries-root ../bin --wallet-daemon-auth none --force && \
	  setsid ../bin/tari_swarm_daemon -c ./config.toml start --no-compile --binaries-root ../bin --wallet-daemon-auth none \
	    >/tmp/tari-swarm.log 2>&1 < /dev/null & \
	  echo "swarm starting in background; log: /tmp/tari-swarm.log  (web UI http://localhost:8080, walletd $(WALLETD_URL))"

swarm-down: ## Stop a running swarm
	-pkill -f tari_swarm_daemon
	-pkill -f tari_validator_node
	-pkill -f tari_ootle_walletd

# ---------------------------------------------------------------- dashboard & demos
.PHONY: dashboard demo demo-otc console
dashboard: ## Run the web dashboard (http://localhost:8787)
	bash web/run.sh

console: ## Run the local AgentPay web console (http://127.0.0.1:8700)
	$(PYTHON) scripts/console.py

demo: ## Chinese terminal walkthrough of on-chain AgentPay limits (ARGS="--auto" / "--otc")
	$(PYTHON) scripts/demo_zh.py $(ARGS)

demo-otc: ## On-chain OtcBoard list -> take -> confirm demo
	$(PYTHON) scripts/otc_demo.py

# ---------------------------------------------------------------- publish (local swarm)
.PHONY: publish-local
publish-local: ## Publish escrow + agent_budget + otc_board to the local swarm
	bash scripts/publish-escrow.sh
	bash scripts/publish-agent.sh
	bash scripts/publish-otc.sh

# ---------------------------------------------------------------- binaries
.PHONY: fetch-binaries
fetch-binaries: ## Download the prebuilt Tari node binaries into node-binaries/bins
	bash scripts/fetch-binaries.sh

# ---------------------------------------------------------------- cleanup
.PHONY: clean
clean: ## Remove Rust build artifacts
	-@for t in $(TEMPLATES); do cargo clean --manifest-path templates/$$t/Cargo.toml; done
	-cargo clean --manifest-path scripts/esme-fund/Cargo.toml
