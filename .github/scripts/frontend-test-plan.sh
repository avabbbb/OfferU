#!/usr/bin/env bash
# Decide whether a PR can run only the frontend Vitest tests its diff reaches
# (`vitest run --changed <base>`) or must run the whole frontend suite.
#
# Usage: frontend-test-plan.sh <base-sha> [head-ref]
# Prints `mode=changed` or `mode=full`, plus `reason=...`.
#
# The frontend suite imports frontend/src, packages/core, packages/sync and
# backend-ts/src (via the @offeru/backend alias). `vitest --changed` follows
# that static import graph, so module edits there are handled precisely.
# Everything a test can reach some other way forces a full run:
#   - dependency / toolchain inputs: lockfiles, package.json, .npmrc, .nvmrc
#   - config: tsconfig*, vite/vitest/postcss/tailwind config, test setup, CI
#   - generated files (*.generated.*, e.g. src/lib/api-types.generated.ts)
#   - non-module files inside the graph roots (json/yaml/html/images/fixtures)
# Changes outside those roots (backend/, docs/, extension/, ...) cannot reach
# the frontend suite and are ignored.
set -euo pipefail

base="${1:?base sha required}"
head="${2:-HEAD}"

changed="$(git diff --name-only "$base" "$head")"

force_config='^(frontend/|packages/(core|sync)/)?(package\.json|package-lock\.json|npm-shrinkwrap\.json|\.npmrc|\.nvmrc|tsconfig[^/]*\.json)$|^frontend/((vite|vitest)\.(config|workspace)\.[cm]?[jt]s|postcss\.config\.[cm]?js|tailwind\.config\.[cm]?js|src/test/)|^\.github/(workflows/build\.yml|actions/frontend-deps/|scripts/frontend-test-plan\.sh)|\.generated\.'
graph_roots='^(frontend/|packages/(core|sync)/|backend-ts/src/)'
ignored_in_roots='^frontend/(src-tauri|scripts)/|^frontend/Dockerfile$|\.md$'
module_file='\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css)$'

while IFS= read -r file; do
  [ -z "$file" ] && continue
  if [[ "$file" =~ $force_config ]]; then
    echo "mode=full"; echo "reason=config or dependency input changed: $file"; exit 0
  fi
  [[ "$file" =~ $graph_roots ]] || continue
  [[ "$file" =~ $ignored_in_roots ]] && continue
  if ! [[ "$file" =~ $module_file ]]; then
    echo "mode=full"; echo "reason=non-module file may be read by tests: $file"; exit 0
  fi
done <<< "$changed"

echo "mode=changed"
echo "reason=only import-graph files changed"
