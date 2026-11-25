#!/bin/sh
# usage: build.sh <radiant dir> <out.js>
set -e
D=$(mktemp -d /private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/materials/kbench/entryXXXX)
cat > $D/entry.ts <<EOF
export { tessellateBranches, BranchMeshCache } from '$1/src/lib/core/geometry/tessellate';
export { packMeshVertices, packVertices } from '$1/src/lib/render/mesh-vertices';
EOF
cd $1 && bun build $D/entry.ts --target browser --format esm --outfile $2 >/dev/null
rm -rf $D
