"""Real SQLite/Bun boundary tests; vectors and domain hits are literal fixtures,
not claims that a neural model or HMM search has been run in this test suite."""
import importlib.util
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import sqlite3
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE))
from protein_inputs import load_protein_inputs  # noqa: E402


def module(name):
    specification = importlib.util.spec_from_file_location(name, SOURCE / (name + ".py"))
    result = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(result)
    return result


esm = module("generate-esm2-embeddings")
pfam = module("generate-pfam-domains")
atlas = module("generate-latent-space-atlas")
MODEL = "fixture-model"
HMM = {"release": "99.0", "hmmSha256": "a" * 64, "eValue": 1e-5,
    "thresholdPolicy": pfam.THRESHOLD_POLICY, "toolVersion": "literal-fixture"}


class AnnotationPublicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("bun"):
            raise RuntimeError("These integration tests require the actual Bun CDS producer")

    def setUp(self):
        # Retain fixture files for inspection; this repository forbids deleting files.
        directory = Path(tempfile.mkdtemp(prefix="phage-protein-publication-"))
        self.directory = directory
        self.connection = sqlite3.connect(directory / "fixture.db")
        self.addCleanup(self.connection.close)
        self.connection.executescript("""
            CREATE TABLE phages (id INTEGER PRIMARY KEY, genome_length INTEGER);
            CREATE TABLE sequences (phage_id INTEGER, chunk_index INTEGER, sequence TEXT);
            CREATE TABLE genes (id INTEGER PRIMARY KEY, phage_id INTEGER, name TEXT, locus_tag TEXT,
                start_pos INTEGER, end_pos INTEGER, strand TEXT, product TEXT, type TEXT, qualifiers TEXT);
            CREATE TABLE fold_embeddings (phage_id INTEGER, gene_id INTEGER, model TEXT, dims INTEGER,
                vector BLOB, meta TEXT, created_at INTEGER, UNIQUE(gene_id, model));
            CREATE TABLE fold_embedding_coords (gene_id INTEGER, model TEXT, x REAL, y REAL);
            CREATE TABLE protein_domains (id INTEGER PRIMARY KEY, phage_id INTEGER, gene_id INTEGER,
                locus_tag TEXT, domain_id TEXT, domain_name TEXT, domain_type TEXT, start INTEGER,
                end INTEGER, score REAL, e_value REAL, description TEXT);
            CREATE TABLE defense_systems (id INTEGER PRIMARY KEY, phage_id INTEGER, gene_id INTEGER,
                locus_tag TEXT, system_type TEXT, system_family TEXT, target_system TEXT,
                mechanism TEXT, confidence REAL, source TEXT);
            CREATE TABLE amg_annotations (id INTEGER PRIMARY KEY, phage_id INTEGER, gene_id INTEGER,
                locus_tag TEXT, amg_type TEXT, kegg_ortholog TEXT, kegg_reaction TEXT,
                kegg_pathway TEXT, pathway_name TEXT, confidence REAL, evidence TEXT);
            CREATE TABLE annotation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        """)
        genome = "ATGCCAAATAAATGTAGTAA"
        self.connection.execute("INSERT INTO phages VALUES (1, ?)", (len(genome),))
        self.connection.execute("INSERT INTO sequences VALUES (1, 0, ?)", (genome,))
        features = [
            (1, 0, 11, {"transl_table": "11", "translation": "MK", "_location": "join(1..3,6..11)",
                "_sourceFeatureIndex": 0, "_segments": [{"start": 0, "end": 3, "strand": "+"},
                    {"start": 5, "end": 11, "strand": "+"}]}),
            (2, 11, 20, {"transl_table": "15", "translation": "MQ", "_location": "12..20",
                "_sourceFeatureIndex": 1, "_segments": [{"start": 11, "end": 20, "strand": "+"}]}),
            (3, 0, 11, {"pseudo": "", "_location": "1..11", "_sourceFeatureIndex": 2}),
        ]
        self.connection.executemany("INSERT INTO genes VALUES (?, 1, ?, ?, ?, ?, '+', 'fixture protein', 'CDS', ?)",
            [(gene_id, "gene" + str(gene_id), "locus" + str(gene_id), start, end, json.dumps(qualifiers))
                for gene_id, start, end, qualifiers in features])
        self.connection.commit()
        self.report = load_protein_inputs(self.connection, log_exclusions=False)

    def embedding_rows(self, *, model=MODEL, revision="b" * 40):
        rows = []
        for item in self.report["proteins"]:
            metadata = {key: item[key] for key in
                ["sourceGeneIds", "sequenceSha256", "cdsSha256", "geneticCode", "codonStart"]}
            metadata.update({"inputMethod": self.report["method"], "revision": revision,
                "pooling": "fixture-normalized", "normalized": True, "source": "literal-unit-test"})
            rows.append((item["phageId"], item["geneId"], model, 2,
                struct.pack("<2f", 0.6, 0.8), json.dumps(metadata), 10))
        return rows

    def domain_rows(self):
        # These small synthetic proteins are not biological HMM positives.
        # Literal rows exercise the real existing rule derivation and publication.
        return [
            (1, 1, "locus1", "PF08684", "fixture Ocr domain", "Pfam", 1, 2, 30.0, 1e-8, "fixture"),
            (1, 2, "locus2", "PF00124", "fixture photosystem domain", "Pfam", 1, 2, 40.0, 1e-9, "fixture"),
        ]

    def snapshot(self):
        return {name: self.connection.execute("SELECT * FROM " + name + " ORDER BY 1, 2").fetchall()
            for name in ["fold_embeddings", "fold_embedding_coords", "protein_domains",
                "defense_systems", "amg_annotations", "annotation_meta"]}

    def seed_curated(self):
        self.connection.execute("INSERT INTO protein_domains VALUES (NULL, 1, 1, 'locus1', 'manual', 'curated', 'Curated', 1, 2, 1, NULL, 'retained')")
        self.connection.execute("INSERT INTO defense_systems VALUES (NULL, 1, 1, 'locus1', 'manual', NULL, 'host', 'curated', 1, 'curated')")
        self.connection.execute("INSERT INTO amg_annotations VALUES (NULL, 1, 1, 'locus1', 'manual', NULL, NULL, NULL, 'curated', 1, 'not JSON: original curated evidence')")
        self.connection.commit()

    def test_shared_producer_reconstructs_join_and_alternate_code(self):
        self.assertEqual([(item["geneId"], item["sequence"]) for item in self.report["proteins"]], [(1, "MK"), (2, "MQ")])
        self.assertEqual(self.report["proteins"][0]["cds"], "ATGAAATAA")
        self.assertEqual(self.report["proteins"][1]["geneticCode"], 15)
        self.assertEqual([item["geneId"] for item in self.report["excluded"]], [3])
        self.assertEqual(self.report["warnings"], [])

    def test_full_embeddings_replace_obsolete_rows_and_invalidate_only_their_projection(self):
        self.connection.executemany("INSERT INTO fold_embeddings VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(1, 3, MODEL, 1, struct.pack("<f", 1), "{}", 1),
             (1, 1, "other-model", 1, struct.pack("<f", 1), "{}", 1)])
        self.connection.executemany("INSERT INTO fold_embedding_coords VALUES (?, ?, 0, 0)", [(3, MODEL), (1, "other-model")])
        self.connection.commit()
        esm.publish_embeddings(self.connection, self.report, self.embedding_rows(), MODEL, 20)
        self.assertEqual(self.connection.execute("SELECT gene_id FROM fold_embeddings WHERE model = ? ORDER BY gene_id", (MODEL,)).fetchall(), [(1,), (2,)])
        self.assertEqual(self.connection.execute("SELECT model FROM fold_embedding_coords").fetchall(), [("other-model",)])
        metadata = json.loads(self.connection.execute("SELECT value FROM annotation_meta WHERE key = 'esm2_embeddings'").fetchone()[0])
        self.assertEqual(metadata["count"], 2)
        self.assertEqual(metadata["input"]["excluded"][0]["geneId"], 3)
        self.assertTrue(metadata["atlasNeedsRebuild"])

    def test_embedding_updates_invalidate_only_matching_atlas_metadata(self):
        self.connection.execute("INSERT INTO annotation_meta VALUES ('latent_space_atlas', ?, 1)",
            (json.dumps({"model": MODEL, "count": 100}),))
        self.connection.commit()
        esm.publish_embeddings(self.connection, self.report, self.embedding_rows(), MODEL, 20)
        self.assertIsNone(self.connection.execute("SELECT * FROM annotation_meta WHERE key = 'latent_space_atlas'").fetchone())
        unrelated = json.dumps({"model": "other-model", "count": 7})
        self.connection.execute("INSERT INTO annotation_meta VALUES ('latent_space_atlas', ?, 1)", (unrelated,))
        self.connection.commit()
        esm.publish_embeddings(self.connection, self.report, self.embedding_rows(), MODEL, 30)
        self.assertEqual(self.connection.execute("SELECT value FROM annotation_meta WHERE key = 'latent_space_atlas'").fetchone()[0], unrelated)

    def test_embedding_updates_invalidate_only_matching_model_specific_atlas_metadata(self):
        self.connection.executemany("INSERT INTO annotation_meta VALUES (?, ?, 1)", [
            ("latent_space_atlas:" + MODEL, json.dumps({"model": MODEL, "count": 2})),
            ("latent_space_atlas:other-model", json.dumps({"model": "other-model", "count": 7})),
        ])
        self.connection.commit()
        esm.publish_embeddings(self.connection, self.report, self.embedding_rows(), MODEL, 20)
        self.assertIsNone(self.connection.execute("SELECT value FROM annotation_meta WHERE key=?", ("latent_space_atlas:" + MODEL,)).fetchone())
        self.assertEqual(json.loads(self.connection.execute("SELECT value FROM annotation_meta WHERE key='latent_space_atlas:other-model'").fetchone()[0])["count"], 7)

    def test_default_embeddings_invalidate_only_default_screening(self):
        model = "facebook/esm2_t6_8M_UR50D"
        self.seed_curated()
        self.connection.execute("INSERT INTO annotation_meta VALUES ('anti_crispr_esm2', '{}', 1)")
        self.connection.execute("INSERT INTO defense_systems VALUES (NULL, 1, 1, 'locus1', 'candidate', NULL, 'host', 'old', 0.1, 'esm2-nn')")
        self.connection.commit()
        esm.publish_embeddings(self.connection, self.report, self.embedding_rows(model=model), model, 20)
        self.assertIsNone(self.connection.execute("SELECT value FROM annotation_meta WHERE key = 'anti_crispr_esm2'").fetchone())
        self.assertEqual(self.connection.execute("SELECT source FROM defense_systems").fetchall(), [("curated",)])

    def test_partial_embedding_update_preserves_other_rows_and_refuses_mixed_revisions(self):
        rows = self.embedding_rows()
        esm.publish_embeddings(self.connection, self.report, rows, MODEL, 20)
        second = self.connection.execute("SELECT * FROM fold_embeddings WHERE gene_id = 2").fetchone()
        changed = list(rows[0])
        changed[4] = struct.pack("<2f", 0.8, 0.6)
        esm.publish_embeddings(self.connection, self.report, [tuple(changed)], MODEL, 30, partial=True)
        self.assertEqual(self.connection.execute("SELECT * FROM fold_embeddings WHERE gene_id = 2").fetchone(), second)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "mix stale inputs or model revisions"):
            esm.publish_embeddings(self.connection, self.report, self.embedding_rows(revision="c" * 40)[:1], MODEL, 40, partial=True)
        self.assertEqual(self.snapshot(), before)

    def test_embedding_insert_error_rolls_back_replacement_and_metadata(self):
        esm.publish_embeddings(self.connection, self.report, self.embedding_rows(), MODEL, 20)
        self.connection.execute("INSERT INTO fold_embedding_coords VALUES (1, ?, 0, 0)", (MODEL,))
        self.connection.execute("CREATE TRIGGER fail_vector BEFORE INSERT ON fold_embeddings WHEN NEW.gene_id = 2 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
        self.connection.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fixture failure"):
            esm.publish_embeddings(self.connection, self.report, self.embedding_rows(), MODEL, 30)
        self.assertEqual(self.snapshot(), before)

    def test_changed_source_prevents_any_embedding_publication(self):
        esm.publish_embeddings(self.connection, self.report, self.embedding_rows(), MODEL, 20)
        before = self.snapshot()
        self.connection.execute("UPDATE sequences SET sequence = 'ATGCCGGGTAAATGTAGTAA'")
        self.connection.commit()
        with self.assertRaisesRegex(RuntimeError, "inputs changed"):
            esm.publish_embeddings(self.connection, self.report, self.embedding_rows(), MODEL, 30)
        self.assertEqual(self.snapshot(), before)

    def test_full_pfam_publishes_domains_and_dependent_rules_preserving_curated_evidence(self):
        self.seed_curated()
        pfam.publish_domains(self.connection, self.report, self.domain_rows(), [1, 2], HMM, 20)
        self.assertEqual(self.connection.execute("SELECT domain_id FROM protein_domains WHERE domain_type = 'Pfam' ORDER BY gene_id").fetchall(), [("PF08684",), ("PF00124",)])
        self.assertEqual(self.connection.execute("SELECT system_family FROM defense_systems WHERE source = 'pfam-domain'").fetchall(), [("Ocr",)])
        self.assertEqual(self.connection.execute("SELECT kegg_ortholog FROM amg_annotations WHERE evidence LIKE '%pfam-domain%'").fetchall(), [("K02703",)])
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM defense_systems WHERE source = 'curated'").fetchone()[0], 1)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM protein_domains WHERE domain_type = 'Curated'").fetchone()[0], 1)
        self.assertEqual(self.connection.execute("SELECT evidence FROM amg_annotations WHERE amg_type = 'manual'").fetchone()[0], "not JSON: original curated evidence")
        metadata = json.loads(self.connection.execute("SELECT value FROM annotation_meta WHERE key = 'pfam_domains'").fetchone()[0])
        self.assertEqual(metadata["hmmSha256"], HMM["hmmSha256"])
        self.assertEqual(metadata["scannedProteins"], 2)

    def test_zero_hit_partial_pfam_clears_only_processed_gene_and_preserves_other_provenance(self):
        pfam.publish_domains(self.connection, self.report, self.domain_rows(), [1, 2], HMM, 20)
        old_manifest = self.connection.execute("SELECT * FROM annotation_meta WHERE key = 'pfam_input:2'").fetchone()
        pfam.publish_domains(self.connection, self.report, [], [1], HMM, 30, partial=True)
        self.assertEqual(self.connection.execute("SELECT gene_id FROM protein_domains").fetchall(), [(2,)])
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM defense_systems WHERE source = 'pfam-domain'").fetchone()[0], 0)
        self.assertEqual(self.connection.execute("SELECT * FROM annotation_meta WHERE key = 'pfam_input:2'").fetchone(), old_manifest)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM amg_annotations").fetchone()[0], 1)
        self.assertEqual(json.loads(self.connection.execute("SELECT value FROM annotation_meta WHERE key = 'domain_defense'").fetchone()[0])["count"], 0)

    def test_partial_pfam_refuses_hmm_or_threshold_changes(self):
        pfam.publish_domains(self.connection, self.report, self.domain_rows(), [1, 2], HMM, 20)
        before = self.snapshot()
        for source in [{**HMM, "hmmSha256": "d" * 64}, {**HMM, "eValue": 1e-3}, {**HMM, "toolVersion": "other-fixture-version"}]:
            with self.assertRaisesRegex(ValueError, "mix stale inputs or HMM releases"):
                pfam.publish_domains(self.connection, self.report, [], [1], source, 30, partial=True)
            self.assertEqual(self.snapshot(), before)

    def test_partial_pfam_does_not_relabel_legacy_rows_without_provenance(self):
        self.connection.execute("INSERT INTO protein_domains VALUES (NULL, 1, 2, 'locus2', 'PF00124', 'legacy', 'Pfam', 1, 2, 1, 0.01, 'legacy')")
        self.connection.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "full annotation"):
            pfam.publish_domains(self.connection, self.report, self.domain_rows()[:1], [1], HMM, 30, partial=True)
        self.assertEqual(self.snapshot(), before)

    def test_pfam_derived_insert_error_rolls_back_all_tables_and_manifests(self):
        pfam.publish_domains(self.connection, self.report, self.domain_rows(), [1, 2], HMM, 20)
        self.connection.execute("CREATE TRIGGER fail_derivative BEFORE INSERT ON amg_annotations BEGIN SELECT RAISE(ABORT, 'derived fixture failure'); END")
        self.connection.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "derived fixture failure"):
            pfam.publish_domains(self.connection, self.report, self.domain_rows(), [1, 2], HMM, 30)
        self.assertEqual(self.snapshot(), before)

    def test_changed_source_prevents_raw_or_derived_pfam_publication(self):
        pfam.publish_domains(self.connection, self.report, self.domain_rows(), [1, 2], HMM, 20)
        before = self.snapshot()
        self.connection.execute("UPDATE sequences SET sequence = 'ATGCCGGGTAAATGTAGTAA'")
        self.connection.commit()
        with self.assertRaisesRegex(RuntimeError, "inputs changed"):
            pfam.publish_domains(self.connection, self.report, self.domain_rows(), [1, 2], HMM, 30)
        self.assertEqual(self.snapshot(), before)

    def test_invalid_coordinates_and_missing_scanned_proteins_fail_before_writes(self):
        before = self.snapshot()
        row = list(self.domain_rows()[0])
        row[7] = 3
        with self.assertRaisesRegex(ValueError, "residue coordinates"):
            pfam.publish_domains(self.connection, self.report, [tuple(row)], [1, 2], HMM, 20)
        with self.assertRaisesRegex(ValueError, "every selected validated protein"):
            pfam.publish_domains(self.connection, self.report, [], [1], HMM, 20)
        with self.assertRaisesRegex(ValueError, "exactly describe"):
            esm.publish_embeddings(self.connection, self.report, self.embedding_rows()[:1], MODEL, 20)
        self.assertEqual(self.snapshot(), before)

    def test_local_pfam_requires_checksum_bound_release_or_explicit_unversioned_mode(self):
        path = self.directory / "fixture.hmm"
        path.write_bytes(b"literal provenance fixture; not an HMM model\n")
        with self.assertRaisesRegex(ValueError, "no verified release metadata"):
            pfam.read_pfam_source(path)
        unknown = pfam.read_pfam_source(path, allow_unversioned=True)
        self.assertEqual(unknown["release"], "unknown")
        self.assertEqual(unknown["sourceStatus"], "unversioned-explicit")
        metadata = {"format": "phage-explorer-pfam-source", "version": 1, "release": "99.0",
            "sourceUrl": pfam.PFAM_BASE + "/releases/Pfam99.0/Pfam-A.hmm.gz",
            "hmmSha256": pfam.sha256_file(path), "releaseInfoSha256": "e" * 64}
        sidecar = path.with_name(path.name + ".source.json")
        sidecar.write_text(json.dumps(metadata), encoding="utf-8")
        verified = pfam.read_pfam_source(path, requested_release="99.0")
        self.assertEqual(verified["release"], "99.0")
        self.assertEqual(verified["hmmSha256"], metadata["hmmSha256"])
        with self.assertRaisesRegex(ValueError, "differs"):
            pfam.read_pfam_source(path, requested_release="98.0")
        with path.open("ab") as changed:
            changed.write(b"changed bytes")
        with self.assertRaisesRegex(ValueError, "does not match"):
            pfam.read_pfam_source(path, allow_unversioned=True)

    def test_release_metadata_requires_an_actual_numeric_version_line(self):
        release, checksum = pfam.parse_release_info(gzip.compress(b"Pfam release: 99.0\n"), "fixture://version.gz")
        self.assertEqual(release, "99.0")
        self.assertEqual(len(checksum), 64)
        with self.assertRaisesRegex(ValueError, "Could not establish"):
            pfam.parse_release_info(gzip.compress(b"Pfam release: current\n"), "fixture://version.gz")
        with self.assertRaisesRegex(ValueError, "numeric"):
            pfam.ensure_pfam(self.directory / "unused.hmm", release="current")

    def test_pfam_publication_rejects_hits_above_its_declared_independent_threshold(self):
        before = self.snapshot()
        row = list(self.domain_rows()[0])
        row[9] = HMM["eValue"] * 10
        with self.assertRaisesRegex(ValueError, "E-value threshold"):
            pfam.publish_domains(self.connection, self.report, [tuple(row)], [1, 2], HMM, 20)
        self.assertEqual(self.snapshot(), before)

    def test_missing_sequence_chunk_fails_the_shared_boundary(self):
        self.connection.execute("UPDATE sequences SET chunk_index = 1")
        self.connection.commit()
        with self.assertRaisesRegex(RuntimeError, "incomplete sequence chunks"):
            load_protein_inputs(self.connection, log_exclusions=False)


class AtlasPublicationTests(unittest.TestCase):
    """Literal projections exercise publication, not UMAP's scientific validity."""
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="phage-atlas-publication-"))
        self.path = self.directory / "fixture.db"
        self.connection = sqlite3.connect(self.path)
        self.addCleanup(self.connection.close)
        self.connection.executescript("""
            CREATE TABLE phages (id INTEGER PRIMARY KEY, genome_length INTEGER);
            CREATE TABLE sequences (phage_id INTEGER, chunk_index INTEGER, sequence TEXT);
            CREATE TABLE genes (id INTEGER PRIMARY KEY, phage_id INTEGER, name TEXT, locus_tag TEXT,
                start_pos INTEGER, end_pos INTEGER, strand TEXT, product TEXT, type TEXT, qualifiers TEXT);
            CREATE TABLE fold_embeddings (phage_id INTEGER, gene_id INTEGER, model TEXT, dims INTEGER,
                vector BLOB, meta TEXT, created_at INTEGER, UNIQUE(gene_id, model));
            CREATE TABLE annotation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        """)
        coding = ["ATGAAATAA", "ATGGCTTAA", "ATGGGTTAA", "ATGTTTTAA", "ATGACTTAA", "ATGTGTTAA"]
        genome = "".join(coding)
        self.connection.execute("INSERT INTO phages VALUES (1, ?)", (len(genome),))
        self.connection.execute("INSERT INTO sequences VALUES (1, 0, ?)", (genome,))
        self.connection.execute("INSERT INTO phages VALUES (2, 0)")
        for i, protein in enumerate(["MK", "MA", "MG", "MF", "MT", "MC"]):
            self.connection.execute("INSERT INTO genes VALUES (?, 1, ?, ?, ?, ?, '+', 'fixture', 'CDS', ?)",
                (i + 1, f"gene{i + 1}", f"locus{i + 1}", i * 9, i * 9 + 9,
                    json.dumps({"translation": protein, "transl_table": "11", "_sourceFeatureIndex": i,
                        "_location": f"{i * 9 + 1}..{i * 9 + 9}"})))
        self.connection.commit()
        self.report = load_protein_inputs(self.connection, log_exclusions=False)
        self.model = atlas.DEFAULT_MODEL
        self.seed_embeddings(self.model)
        self.coords = [[float(i), float(i * i)] for i in range(6)]
        self.clusters = [0, 0, 0, 1, 1, -1]
        self.scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.9]
        self.method = {"id": "literal-publication-test", "parameters": {"purpose": "transaction tests only"}}

    def seed_embeddings(self, model):
        rows = []
        for i, item in enumerate(self.report["proteins"]):
            meta = {key: item[key] for key in
                ["sourceGeneIds", "sequenceSha256", "cdsSha256", "geneticCode", "codonStart"]}
            meta.update({"inputMethod": self.report["method"], "revision": "b" * 40,
                "checkpoint": model, "pooling": atlas.POOLING, "normalized": True,
                "source": "literal-unit-test", "sequenceLength": len(item["sequence"]), "truncated": False,
                "encodedResidues": len(item["sequence"]),
                "encodedSequenceSha256": hashlib.sha256(item["sequence"].encode()).hexdigest()})
            rows.append((1, item["geneId"], model, 2,
                struct.pack("<2f", math.cos(i / 3), math.sin(i / 3)), json.dumps(meta), 10))
        self.connection.executemany("INSERT INTO fold_embeddings VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
        self.connection.execute("INSERT OR REPLACE INTO annotation_meta VALUES ('esm2_embeddings', ?, 10)",
            (json.dumps({"model": model, "count": len(rows), "atlasNeedsRebuild": True}),))
        self.connection.commit()

    def inputs(self, model=None):
        return atlas.read_atlas_inputs(self.connection, model or self.model)

    def publish(self, inputs=None):
        return atlas.publish_atlas(self.connection, inputs or self.inputs(), self.coords,
            self.clusters, self.scores, self.method, 20)

    def snapshot(self):
        names = self.connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        return {name: self.connection.execute('SELECT * FROM "' + name + '" ORDER BY 1, 2').fetchall() for name, in names}

    def test_atlas_replaces_stale_rows_and_preserves_other_model(self):
        inputs = self.inputs()
        result = self.publish(inputs)
        self.assertEqual(result["inputSha256"], inputs.sha256)
        self.assertEqual(result["coverage"], {"eligibleProteins": 6, "embeddedProteins": 6})
        self.assertEqual((result["clusters"], result["outliers"]), (2, 1))
        self.assertEqual(result["embeddingSpace"]["revision"], "b" * 40)
        self.assertAlmostEqual(result["mean_outlier_score"], 0.4)
        self.connection.execute("INSERT INTO fold_embedding_coords VALUES (NULL, 1, 999, ?, 9, 9, -1, 1, 1)", (self.model,))
        self.connection.execute("INSERT INTO fold_embedding_coords VALUES (NULL, 1, 1, 'other-model', 7, 8, 2, 0.3, 1)")
        self.connection.execute("INSERT INTO annotation_meta VALUES ('latent_space_atlas:other-model', 'preserved reference', 1)")
        self.connection.commit()
        self.publish(inputs)
        rows = self.connection.execute("SELECT gene_id, x, y FROM fold_embedding_coords WHERE model = ? ORDER BY gene_id", (self.model,)).fetchall()
        self.assertEqual(rows, [(i + 1, point[0], point[1]) for i, point in enumerate(self.coords)])
        self.assertEqual(self.connection.execute("SELECT x, y FROM fold_embedding_coords WHERE model='other-model'").fetchall(), [(7, 8)])
        self.assertEqual(self.connection.execute("SELECT value FROM annotation_meta WHERE key='latent_space_atlas:other-model'").fetchone()[0], "preserved reference")
        meta = json.loads(self.connection.execute("SELECT value FROM annotation_meta WHERE key='esm2_embeddings'").fetchone()[0])
        self.assertFalse(meta["atlasNeedsRebuild"])
        self.assertEqual(meta["atlasInputSha256"], inputs.sha256)
        self.assertEqual(json.loads(self.connection.execute("SELECT value FROM annotation_meta WHERE key='latent_space_atlas'").fetchone()[0]), result)

    def test_other_model_publication_keeps_the_default_ui_metadata(self):
        self.publish()
        before = self.connection.execute("SELECT value FROM annotation_meta WHERE key='latent_space_atlas'").fetchone()[0]
        self.seed_embeddings("other-model")
        result = self.publish(self.inputs("other-model"))
        self.assertEqual(result["model"], "other-model")
        self.assertEqual(self.connection.execute("SELECT value FROM annotation_meta WHERE key='latent_space_atlas'").fetchone()[0], before)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM fold_embedding_coords").fetchone()[0], 12)

    def test_rollback_preserves_complete_previous_atlas_and_metadata(self):
        self.publish()
        self.connection.execute("CREATE TRIGGER fail_atlas BEFORE INSERT ON fold_embedding_coords WHEN NEW.gene_id=2 BEGIN SELECT RAISE(ABORT, 'literal insert failure'); END")
        self.connection.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "literal insert failure"):
            self.publish()
        self.assertEqual(self.snapshot(), before)

    def test_changed_vectors_or_metadata_prevent_stale_publication(self):
        self.publish()
        for sql, values in [
            ("UPDATE fold_embeddings SET vector=? WHERE gene_id=1", (struct.pack("<2f", 0, 1),)),
            ("UPDATE fold_embeddings SET meta=json_set(meta, '$.extraReference', 'changed') WHERE gene_id=1", ()),
        ]:
            inputs = self.inputs()
            self.connection.execute(sql, values)
            self.connection.commit()
            before = self.snapshot()
            with self.assertRaisesRegex(RuntimeError, "Embedding inputs changed"):
                self.publish(inputs)
            self.assertEqual(self.snapshot(), before)

    def test_changed_cds_with_unchanged_vectors_cannot_publish(self):
        inputs = self.inputs()
        self.publish(inputs)
        # A synonymous change retains the protein, but changes the actual CDS input.
        self.connection.execute("UPDATE sequences SET sequence=replace(sequence, 'ATGAAATAA', 'ATGAAGTAA')")
        self.connection.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "Genomic CDS inputs changed"):
            self.publish(inputs)
        with self.assertRaisesRegex(ValueError, "CDS provenance"):
            self.inputs()
        self.assertEqual(self.snapshot(), before)

    def test_invalid_vectors_and_ownership_fail_before_atlas_schema_is_created(self):
        updates = [
            ("phage_id=?", (2,), "owned"),
            ("dims=?", (3,), "dimensions"),
            ("vector=?", (struct.pack("<2f", float('nan'), 1),), "finite"),
            ("vector=?", (struct.pack("<2f", 0, 0),), "normalized"),
            ("meta=?", ("{}",), "CDS provenance"),
            ("meta=json_set(meta, '$.revision', ?)", ("c" * 40,), "mix"),
            ("meta=json_set(meta, '$.encodedSequenceSha256', ?)", ("d" * 64,), "encoded-residue"),
        ]
        for expression, values, error in updates:
            with self.subTest(expression=expression, error=error):
                self.connection.execute("BEGIN")
                self.connection.execute("UPDATE fold_embeddings SET " + expression + " WHERE gene_id=1", values)
                with self.assertRaisesRegex(ValueError, error):
                    # Explicit report lets this read see our uncommitted vector fault.
                    atlas.read_atlas_inputs(self.connection, self.model, self.report)
                self.connection.rollback()
        self.assertIsNone(self.connection.execute("SELECT name FROM sqlite_master WHERE name='fold_embedding_coords'").fetchone())

    def test_invalid_or_incomplete_outputs_preserve_previous_generation(self):
        self.publish()
        inputs = self.inputs()
        before = self.snapshot()
        for coords, clusters, scores in [
            (self.coords[:-1], self.clusters, self.scores),
            ([[float('nan'), 0], *self.coords[1:]], self.clusters, self.scores),
            (self.coords, [-2, *self.clusters[1:]], self.scores),
            (self.coords, self.clusters, [1.1, *self.scores[1:]]),
        ]:
            with self.assertRaisesRegex(ValueError, "outputs"):
                atlas.publish_atlas(self.connection, inputs, coords, clusters, scores, self.method, 30)
            self.assertEqual(self.snapshot(), before)

    def test_missing_input_and_small_fitting_corpus_fail_without_writes(self):
        with self.assertRaises(sqlite3.OperationalError):
            atlas.process_database(str(self.directory / "absent.db"))
        self.assertFalse((self.directory / "absent.db").exists())
        inputs = self.inputs()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "at least four"):
            atlas.compute_projection(inputs._replace(rows=inputs.rows[:3]))
        self.assertEqual(self.snapshot(), before)

    def test_failed_fitting_leaves_source_byte_identical(self):
        self.publish()
        before = self.path.read_bytes()
        with patch.object(atlas, "compute_projection", side_effect=RuntimeError("literal fit failure")):
            with self.assertRaisesRegex(RuntimeError, "literal fit failure"):
                atlas.process_database(str(self.path))
        self.assertEqual(self.path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
