"""Real SQLite/Bun boundary tests; vectors and domain hits are literal fixtures,
not claims that a neural model or HMM search has been run in this test suite."""
import importlib.util
import gzip
import json
from pathlib import Path
import shutil
import sqlite3
import struct
import sys
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
