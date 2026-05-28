# MyBooks Browser Extension – Makefile
#
# Targets:
#   make pack      – build a versioned .zip for Chrome/Edge (MV3)
#   make dev       – launch Chrome with the extension loaded unpacked (no zip needed)
#   make clean     – remove the dist/ directory
#   make version   – print the current version from manifest.json

SHELL := /bin/bash

SRC_DIR   := main
DIST_DIR  := dist

# Absolute path to the extension source (needed for --load-extension)
ABS_SRC_DIR := $(abspath $(SRC_DIR))

# Chrome/Chromium binary – override with: make dev CHROME=/path/to/chrome
CHROME ?= /Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# Dedicated user-data-dir so the dev profile is isolated from your real Chrome
DEV_PROFILE := $(DIST_DIR)/chrome-dev-profile

# Extract version from manifest.json (requires python3 or jq)
VERSION := $(shell \
  if command -v jq &>/dev/null; then \
    jq -r '.version' $(SRC_DIR)/manifest.json; \
  else \
    python3 -c "import json,sys; print(json.load(open('$(SRC_DIR)/manifest.json'))['version'])"; \
  fi)

ZIP_NAME  := mybooks-extension-v$(VERSION).zip

# Files to include in the package (all files under main/, no hidden files)
SRC_FILES := $(shell find $(SRC_DIR) -type f ! -name '.*')

.PHONY: all pack dev clean version

all: pack

## Build a distributable .zip archive
pack: $(DIST_DIR)/$(ZIP_NAME)

$(DIST_DIR)/$(ZIP_NAME): $(SRC_FILES)
	@mkdir -p $(DIST_DIR)
	@echo "Packaging extension v$(VERSION) → $(DIST_DIR)/$(ZIP_NAME)"
	@cd $(SRC_DIR) && zip -r -FS "../$(DIST_DIR)/$(ZIP_NAME)" . --exclude '.*' --exclude '__pycache__/*'
	@echo "Done: $(DIST_DIR)/$(ZIP_NAME)"

## Remove build artifacts
clean:
	@echo "Removing $(DIST_DIR)/"
	@rm -rf $(DIST_DIR)

## Launch Chrome with the extension loaded unpacked (isolated dev profile)
dev:
	@mkdir -p "$(DEV_PROFILE)"
	@echo "Launching Chrome with unpacked extension: $(ABS_SRC_DIR)"
	@"$(CHROME)" \
	  --load-extension="$(ABS_SRC_DIR)" \
	  --user-data-dir="$(DEV_PROFILE)" \
	  --no-first-run \
	  --no-default-browser-check &

## Print current extension version
version:
	@echo $(VERSION)
