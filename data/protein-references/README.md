# Lambda J / LamB reference inputs

`lambda-lamb-v1.json` is a public, source-attributed input snapshot consumed by
`loadProteinReferenceInputs`, the web Host Interactions panel and the portable
protein-structure workflow. The workflow computes finite-sample alignment
diversity and observed C-alpha distances from this exact snapshot. It does not
provide a host-range prediction, calibrated affinity, docking energy,
solvent-accessible surface area or mutation-effect estimate.

The snapshot contains:

- Complete UniProt P03749 (Lambda J), Q3YUU9 (LamB sequence reference), and
  P0DXX7 (a real J homolog), with source sequence digests.
- An exact catalog CDS mapping for NC_001416.1 / NP_040600.1. The service checks
  the actual genomic translation through the existing repository before
  reporting availability; names and locus aliases do not establish identity.
- PDB **8XCJ, revision 1.3, biological assembly 1**: J label chain D / author chain Z,
  residues 713–1132, and LamB label/author chain A, residues 25–446. The snapshot
  retains 420 and 422 observed C-alpha coordinates respectively, not inferred
  atoms or a full-length J structure. Label and author numbering are distinct.
- A deterministic two-source, full-protein Needleman–Wunsch alignment, with
  explicit gaps (match 2, mismatch −1, gap −2). Two homolog sequences do not establish
  population conservation or calibrated evolutionary constraint.
- Two actual 320-feature, L2-normalized ESM2 vectors for those exact structural
  intervals. Both use `facebook/esm2_t6_8M_UR50D` at revision
  `c731040fcd8d73dceaa04b0a8e6329b345b0f5df`, CPU/fp32,
  Transformers 4.57.1 / Torch 2.8.0+cpu. Attention-mask mean pooling includes BOS/EOS;
  there is no sequence truncation or masked-token-logit substitution.
- Published domain/loop interaction assignments for this complex, linked to
  Ge and Wang 2024, Results and Figure 2. These are experimental context,
  not a general Pfam-pair interaction probability.

The experimental receptor is **Shigella sonnei 3070**. Q3YUU9 is a sequence
reference from strain Ss046 whose mapped interval exactly matches the deposited
chain. A sequence match does not equate the strains or transfer host-range claims.

## Attribution and integrity

Each source retains its URI, version, retrieval time, license and raw-file SHA256.
UniProt data are CC-BY-4.0; RCSB archive/API data are CC0-1.0; the publication is
CC-BY-4.0; the pinned ESM2 checkpoint is MIT. The JSON contains per-source
attribution links. The validator checks content identity and cross-record
consistency; checksums do not authenticate a source or validate an inference.

Primary sources: [UniProt J](https://rest.uniprot.org/uniprotkb/P03749.json),
[LamB](https://rest.uniprot.org/uniprotkb/Q3YUU9.json),
[J homolog](https://rest.uniprot.org/uniprotkb/P0DXX7.json),
[8XCJ](https://www.rcsb.org/structure/8XCJ), and
[Ge and Wang 2024](https://www.nature.com/articles/s41467-024-48686-3).

## Rebuild with explicit public inputs

Run from the repository root. Choose a new external output directory; the tools
refuse to overwrite outputs. No catalog DB is opened by the reference embedding
mode. Do not pass private imported genomes to this source-acquisition workflow.

```sh
reference_run="$(mktemp -d /tmp/phage-public-reference.XXXXXX)"
bun -e 'import { writeFile } from "node:fs/promises";
  const bundle = await Bun.file("data/protein-references/lambda-lamb-v1.json").json();
  await writeFile(Bun.argv[1], JSON.stringify(bundle.chains.map(chain => ({
    proteinId: chain.proteinId, start: chain.start, end: chain.end, sequence: chain.sequence
  }))), { flag: "wx" });' "$reference_run/embedding-inputs.json"

uv run --python 3.12 \
  --with 'https://download.pytorch.org/whl/cpu/torch-2.8.0%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl' \
  --with 'transformers==4.57.1' \
  python packages/data-pipeline/src/generate-esm2-embeddings.py \
  --model facebook/esm2_t6_8M_UR50D \
  --revision c731040fcd8d73dceaa04b0a8e6329b345b0f5df \
  --reference-input "$reference_run/embedding-inputs.json" \
  --reference-output "$reference_run/vectors.json"

bun packages/data-pipeline/src/build-protein-reference.ts \
  --source-dir "$reference_run" --download \
  --vectors "$reference_run/vectors.json" --output "$reference_run/reference.json"
```

The CPU wheel above targets Linux x86-64 / CPython 3.12. Use the same declared
implementation when checking vector reproducibility. New acquisition timestamps
change bundle identity; compare the sequence, model and vector records separately.
The builder refuses changed upstream bytes: retain original raw sources for an
exact rebuild, or explicitly review a new reference version. It never silently
updates this snapshot. Public API responses and article XML may change even
when their scientific version labels have not changed.

Focused verification:

```sh
bun test packages/core/src/protein-reference.test.ts \
  packages/data-pipeline/src/build-protein-reference.test.ts \
  packages/web/src/components/overlays/protein-reference.test.tsx
```

The browser regression is `packages/web/e2e/protein-reference.e2e.ts`. It uses the
actual catalog and reference bytes, delays their delivery to check cancellation,
exports the complete input record, and verifies that T4 remains unavailable.

## Analyze and replay an exact reference snapshot

The headless commands accept a validated version-1 reference JSON, including
complete source proteins, explicit alignment rows and mapped observed C-alpha
coordinates. They do not fetch external structures, interpret raw PDB/mmCIF,
load the catalog, or check the declared CDS against a currently selected genome.
The interactive current-CDS path separately performs the genomic translation
check through `loadProteinReferenceInputs`.

Run from a source checkout; every output path must be new:

```sh
bun run workflow inspect-protein-reference \
  --input data/protein-references/lambda-lamb-v1.json

bun run workflow analyze-protein-structure \
  --input data/protein-references/lambda-lamb-v1.json \
  --protein lambda-j --chain D --cutoff 8 --min-separation 3 \
  --contact-scope assembly --output lambda-reference-evidence.json

bun run workflow replay-experiment \
  --input lambda-reference-evidence.json --output lambda-reference-replayed.json

bun run workflow replay-experiment \
  --input lambda-reference-evidence.json --format tsv --output lambda-residues.tsv

bun run workflow analyze-protein-structure \
  --input data/protein-references/lambda-lamb-v1.json \
  --protein lambda-j --chain D --cutoff 8 --min-separation 3 \
  --contact-scope assembly --format tsv --section contacts \
  --output lambda-contacts.tsv
```

A compiled executable uses the same commands with the prefix
`phage-explorer workflow` in place of `bun run workflow`.
The production executable embeds the existing research worker; these commands
do not start a second Bun process or open the database.

The default protein is the snapshot's declared CDS protein. A chain is selected
automatically only when exactly one supplied chain maps to that protein; use
`--chain LABEL_ID` for an explicit choice, or `--chain none` for alignment-only
analysis. Label chain IDs and author chain IDs are different identifiers: in this
snapshot J is label chain D and author chain Z, so the analysis selector is D.
All five effective settings are retained in the experiment. The default distance
cutoff is 8 Angstroms, minimum sequence separation is 3 residues and contact
scope is `assembly`.

| Output | Meaning and coverage |
| --- | --- |
| Entropy in bits | Unweighted Shannon diversity among non-gap residues in the supplied alignment column; fewer than two observed residues gives an unavailable value. Two sequences do not establish population conservation. |
| Intrachain neighbors | Observed C-alpha pairs within the chosen distance cutoff, excluding pairs closer in sequence than the selected minimum separation. Each contact is stored once. |
| Interchain neighbors | Proximity between the chosen chain and the other supplied chains in the same validated coordinate frame. `--contact-scope chain` leaves this unexamined and unavailable. |
| Missing coordinates | Unavailable geometry; no atoms, missing residues or symmetry copies are reconstructed. |
| Residue TSV | Every source-protein position, alignment column and coverage, deposited label/author numbering, insertion code, coordinates and neighbor counts. |
| Contact TSV | Every retained observed pair with both mapped source identities and its C-alpha distance. |

The finite cutoff is a descriptive geometry parameter. A zero interchain contact
count means no supplied C-alpha pair meets that cutoff; it does not establish
absence of binding or biological interaction. The snapshot contains only two
retained chains, not every biological assembly copy or atom.

JSON exports embed the exact source snapshot once, source attribution, complete
settings, coverage and method identity. `replay-experiment` validates the stored
hashes and reruns the method from embedded inputs, then compares the freshly
computed evidence. A rehashed file containing altered entropy or distances is
not accepted as a successful replay. This verifies computational reproducibility,
not source authenticity or experimental validity.

Reference inputs are limited to 512 KiB of UTF-8 JSON. Computation is bounded by
20 million coordinate-pair checks and 20,000 retained contacts; an exceeded budget
is an error, with no truncated successful result. Portable experiment JSON is
bounded to 10 MiB. Outputs are exclusively created with owner-only permissions;
existing files and symlinks are never replaced. A final interrupted write may
leave a partial new file. `--timeout-ms` covers input, computation and output;
cancellation terminates the owned worker.

Focused native verification:

```sh
bun test packages/tui/src/research-protein.test.ts
```
