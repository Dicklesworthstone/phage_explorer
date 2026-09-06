/**
 * Result of bond detection
 */
export class BondDetectionResult {
    static __wrap(ptr) {
        const obj = Object.create(BondDetectionResult.prototype);
        obj.__wbg_ptr = ptr;
        BondDetectionResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BondDetectionResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_bonddetectionresult_free(ptr, 0);
    }
    /**
     * Get the number of bonds
     * @returns {number}
     */
    get bond_count() {
        const ret = wasm.bonddetectionresult_bond_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get bonds as flat array [a0, b0, a1, b1, ...]
     * @returns {Uint32Array}
     */
    get bonds() {
        const ret = wasm.bonddetectionresult_bonds(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) BondDetectionResult.prototype[Symbol.dispose] = BondDetectionResult.prototype.free;

export class CgrCountsResult {
    static __wrap(ptr) {
        const obj = Object.create(CgrCountsResult.prototype);
        obj.__wbg_ptr = ptr;
        CgrCountsResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CgrCountsResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_cgrcountsresult_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    get counts() {
        const ret = wasm.cgrcountsresult_counts(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get entropy() {
        const ret = wasm.cgrcountsresult_entropy(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get k() {
        const ret = wasm.cgrcountsresult_k(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get max_count() {
        const ret = wasm.cgrcountsresult_max_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get resolution() {
        const ret = wasm.cgrcountsresult_resolution(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get total_points() {
        const ret = wasm.cgrcountsresult_total_points(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) CgrCountsResult.prototype[Symbol.dispose] = CgrCountsResult.prototype.free;

/**
 * Result of codon usage analysis.
 */
export class CodonUsageResult {
    static __wrap(ptr) {
        const obj = Object.create(CodonUsageResult.prototype);
        obj.__wbg_ptr = ptr;
        CodonUsageResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CodonUsageResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_codonusageresult_free(ptr, 0);
    }
    /**
     * Get the codon counts as a JSON string.
     * @returns {string}
     */
    get json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.codonusageresult_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) CodonUsageResult.prototype[Symbol.dispose] = CodonUsageResult.prototype.free;

/**
 * Error codes for dense k-mer counting.
 * @enum {1 | 2 | 3}
 */
export const DenseKmerError = Object.freeze({
    /**
     * K value exceeds safe maximum (currently 10)
     */
    KTooLarge: 1, "1": "KTooLarge",
    /**
     * K value is zero
     */
    KZero: 2, "2": "KZero",
    /**
     * Sequence is shorter than k
     */
    SequenceTooShort: 3, "3": "SequenceTooShort",
});

/**
 * Result of dense k-mer counting.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class DenseKmerResult {
    static __wrap(ptr) {
        const obj = Object.create(DenseKmerResult.prototype);
        obj.__wbg_ptr = ptr;
        DenseKmerResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DenseKmerResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_densekmerresult_free(ptr, 0);
    }
    /**
     * Get the k-mer counts as a Uint32Array.
     * Length is 4^k where each index represents a k-mer in base-4 encoding:
     * - A=0, C=1, G=2, T=3
     * - Index = sum(base[i] * 4^(k-1-i)) for i in 0..k
     *
     * Example for k=2: index 0=AA, 1=AC, 2=AG, 3=AT, 4=CA, ... 15=TT
     * @returns {Uint32Array}
     */
    get counts() {
        const ret = wasm.densekmerresult_counts(this.__wbg_ptr);
        return ret;
    }
    /**
     * K value used for counting.
     * @returns {number}
     */
    get k() {
        const ret = wasm.densekmerresult_k(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Total number of valid k-mers counted (windows without N/ambiguous bases).
     * @returns {bigint}
     */
    get total_valid() {
        const ret = wasm.densekmerresult_total_valid(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Get the number of unique k-mers (non-zero counts).
     * @returns {number}
     */
    get unique_count() {
        const ret = wasm.densekmerresult_unique_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) DenseKmerResult.prototype[Symbol.dispose] = DenseKmerResult.prototype.free;

/**
 * Result buffers for dotplot computation.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class DotPlotBuffers {
    static __wrap(ptr) {
        const obj = Object.create(DotPlotBuffers.prototype);
        obj.__wbg_ptr = ptr;
        DotPlotBuffersFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DotPlotBuffersFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dotplotbuffers_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get bins() {
        const ret = wasm.dotplotbuffers_bins(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Flattened direct identity values (row-major, bins*bins).
     * @returns {Float32Array}
     */
    get direct() {
        const ret = wasm.dotplotbuffers_direct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Flattened inverted identity values (row-major, bins*bins).
     * @returns {Float32Array}
     */
    get inverted() {
        const ret = wasm.dotplotbuffers_inverted(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get window() {
        const ret = wasm.dotplotbuffers_window(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) DotPlotBuffers.prototype[Symbol.dispose] = DotPlotBuffers.prototype.free;

/**
 * Result of functional group detection.
 * Contains flat arrays of atom indices for each functional group type.
 */
export class FunctionalGroupResult {
    static __wrap(ptr) {
        const obj = Object.create(FunctionalGroupResult.prototype);
        obj.__wbg_ptr = ptr;
        FunctionalGroupResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FunctionalGroupResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_functionalgroupresult_free(ptr, 0);
    }
    /**
     * Number of aromatic rings.
     * @returns {number}
     */
    get aromatic_count() {
        const ret = wasm.functionalgroupresult_aromatic_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get aromatic ring atom indices as flat array.
     * @returns {Uint32Array}
     */
    get aromatic_indices() {
        const ret = wasm.functionalgroupresult_aromatic_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Number of disulfide bonds.
     * @returns {number}
     */
    get disulfide_count() {
        const ret = wasm.functionalgroupresult_disulfide_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get disulfide bond pairs as flat array [s1, s2, s1, s2, ...].
     * @returns {Uint32Array}
     */
    get disulfide_pairs() {
        const ret = wasm.functionalgroupresult_disulfide_pairs(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Number of phosphate groups.
     * @returns {number}
     */
    get phosphate_count() {
        const ret = wasm.functionalgroupresult_phosphate_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get phosphate group data.
     * @returns {Uint32Array}
     */
    get phosphate_data() {
        const ret = wasm.functionalgroupresult_phosphate_data(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get sizes of each aromatic ring.
     * @returns {Uint32Array}
     */
    get ring_sizes() {
        const ret = wasm.functionalgroupresult_ring_sizes(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) FunctionalGroupResult.prototype[Symbol.dispose] = FunctionalGroupResult.prototype.free;

/**
 * Result of Hoeffding's D computation
 */
export class HoeffdingResult {
    static __wrap(ptr) {
        const obj = Object.create(HoeffdingResult.prototype);
        obj.__wbg_ptr = ptr;
        HoeffdingResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HoeffdingResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hoeffdingresult_free(ptr, 0);
    }
    /**
     * Hoeffding's D statistic. Range: approximately [-0.5, 1]
     * Values near 0 indicate independence, larger values indicate dependence.
     * Unlike correlation, captures non-linear relationships.
     * @returns {number}
     */
    get d() {
        const ret = wasm.__wbg_get_hoeffdingresult_d(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of observations used
     * @returns {number}
     */
    get n() {
        const ret = wasm.__wbg_get_hoeffdingresult_n(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Hoeffding's D statistic. Range: approximately [-0.5, 1]
     * Values near 0 indicate independence, larger values indicate dependence.
     * Unlike correlation, captures non-linear relationships.
     * @param {number} arg0
     */
    set d(arg0) {
        wasm.__wbg_set_hoeffdingresult_d(this.__wbg_ptr, arg0);
    }
    /**
     * Number of observations used
     * @param {number} arg0
     */
    set n(arg0) {
        wasm.__wbg_set_hoeffdingresult_n(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) HoeffdingResult.prototype[Symbol.dispose] = HoeffdingResult.prototype.free;

/**
 * Result of KL divergence window scan.
 */
export class KLScanResult {
    static __wrap(ptr) {
        const obj = Object.create(KLScanResult.prototype);
        obj.__wbg_ptr = ptr;
        KLScanResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KLScanResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_klscanresult_free(ptr, 0);
    }
    /**
     * Get the k-mer size used
     * @returns {number}
     */
    get k() {
        const ret = wasm.klscanresult_k(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the KL divergence values as Float32Array
     * @returns {Float32Array}
     */
    get kl_values() {
        const ret = wasm.klscanresult_kl_values(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get the window start positions as Uint32Array
     * @returns {Uint32Array}
     */
    get positions() {
        const ret = wasm.klscanresult_positions(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get the number of windows
     * @returns {number}
     */
    get window_count() {
        const ret = wasm.klscanresult_window_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) KLScanResult.prototype[Symbol.dispose] = KLScanResult.prototype.free;

export class KmerAnalysisResult {
    static __wrap(ptr) {
        const obj = Object.create(KmerAnalysisResult.prototype);
        obj.__wbg_ptr = ptr;
        KmerAnalysisResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KmerAnalysisResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_kmeranalysisresult_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get bray_curtis_dissimilarity() {
        const ret = wasm.__wbg_get_kmeranalysisresult_bray_curtis_dissimilarity(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get containment_a_in_b() {
        const ret = wasm.__wbg_get_kmeranalysisresult_containment_a_in_b(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get containment_b_in_a() {
        const ret = wasm.__wbg_get_kmeranalysisresult_containment_b_in_a(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get cosine_similarity() {
        const ret = wasm.__wbg_get_kmeranalysisresult_cosine_similarity(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get jaccard_index() {
        const ret = wasm.__wbg_get_kmeranalysisresult_jaccard_index(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get k() {
        const ret = wasm.__wbg_get_kmeranalysisresult_k(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get shared_kmers() {
        const ret = wasm.__wbg_get_kmeranalysisresult_shared_kmers(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get unique_kmers_a() {
        const ret = wasm.__wbg_get_kmeranalysisresult_unique_kmers_a(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get unique_kmers_b() {
        const ret = wasm.__wbg_get_kmeranalysisresult_unique_kmers_b(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set bray_curtis_dissimilarity(arg0) {
        wasm.__wbg_set_kmeranalysisresult_bray_curtis_dissimilarity(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set containment_a_in_b(arg0) {
        wasm.__wbg_set_kmeranalysisresult_containment_a_in_b(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set containment_b_in_a(arg0) {
        wasm.__wbg_set_kmeranalysisresult_containment_b_in_a(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set cosine_similarity(arg0) {
        wasm.__wbg_set_kmeranalysisresult_cosine_similarity(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set jaccard_index(arg0) {
        wasm.__wbg_set_kmeranalysisresult_jaccard_index(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set k(arg0) {
        wasm.__wbg_set_kmeranalysisresult_k(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set shared_kmers(arg0) {
        wasm.__wbg_set_kmeranalysisresult_shared_kmers(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set unique_kmers_a(arg0) {
        wasm.__wbg_set_kmeranalysisresult_unique_kmers_a(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set unique_kmers_b(arg0) {
        wasm.__wbg_set_kmeranalysisresult_unique_kmers_b(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) KmerAnalysisResult.prototype[Symbol.dispose] = KmerAnalysisResult.prototype.free;

/**
 * Result of MinHash signature computation.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class MinHashSignature {
    static __wrap(ptr) {
        const obj = Object.create(MinHashSignature.prototype);
        obj.__wbg_ptr = ptr;
        MinHashSignatureFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MinHashSignatureFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_minhashsignature_free(ptr, 0);
    }
    /**
     * K value used for hashing.
     * @returns {number}
     */
    get k() {
        const ret = wasm.minhashsignature_k(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of hash functions (signature length).
     * @returns {number}
     */
    get num_hashes() {
        const ret = wasm.minhashsignature_num_hashes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the signature as a Uint32Array.
     * Length equals num_hashes parameter.
     * Each element is the minimum hash value for that seed.
     * @returns {Uint32Array}
     */
    get signature() {
        const ret = wasm.minhashsignature_signature(this.__wbg_ptr);
        return ret;
    }
    /**
     * Total number of valid k-mers hashed.
     * @returns {bigint}
     */
    get total_kmers() {
        const ret = wasm.minhashsignature_total_kmers(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
}
if (Symbol.dispose) MinHashSignature.prototype[Symbol.dispose] = MinHashSignature.prototype.free;

/**
 * Result of Myers diff computation.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class MyersDiffResult {
    static __wrap(ptr) {
        const obj = Object.create(MyersDiffResult.prototype);
        obj.__wbg_ptr = ptr;
        MyersDiffResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MyersDiffResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_myersdiffresult_free(ptr, 0);
    }
    /**
     * Number of deletions.
     * @returns {number}
     */
    get deletions() {
        const ret = wasm.myersdiffresult_deletions(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Edit distance (total number of edits).
     * @returns {number}
     */
    get edit_distance() {
        const ret = wasm.myersdiffresult_edit_distance(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Error message if any.
     * @returns {string | undefined}
     */
    get error() {
        const ret = wasm.myersdiffresult_error(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Sequence identity as fraction (0.0 - 1.0).
     * @returns {number}
     */
    get identity() {
        const ret = wasm.myersdiffresult_identity(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of insertions.
     * @returns {number}
     */
    get insertions() {
        const ret = wasm.myersdiffresult_insertions(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Length of sequence A.
     * @returns {number}
     */
    get len_a() {
        const ret = wasm.myersdiffresult_len_a(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Length of sequence B.
     * @returns {number}
     */
    get len_b() {
        const ret = wasm.myersdiffresult_len_b(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get mask for sequence A as Uint8Array.
     * Values: 0=MATCH, 1=MISMATCH, 3=DELETE
     * @returns {Uint8Array}
     */
    get mask_a() {
        const ret = wasm.myersdiffresult_mask_a(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get mask for sequence B as Uint8Array.
     * Values: 0=MATCH, 1=MISMATCH, 2=INSERT
     * @returns {Uint8Array}
     */
    get mask_b() {
        const ret = wasm.myersdiffresult_mask_b(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of matching positions.
     * @returns {number}
     */
    get matches() {
        const ret = wasm.myersdiffresult_matches(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of mismatches (substitutions).
     * @returns {number}
     */
    get mismatches() {
        const ret = wasm.myersdiffresult_mismatches(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Whether the computation was truncated.
     * @returns {boolean}
     */
    get truncated() {
        const ret = wasm.myersdiffresult_truncated(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) MyersDiffResult.prototype[Symbol.dispose] = MyersDiffResult.prototype.free;

/**
 * PCA result buffers in f32.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class PCAResultF32 {
    static __wrap(ptr) {
        const obj = Object.create(PCAResultF32.prototype);
        obj.__wbg_ptr = ptr;
        PCAResultF32Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PCAResultF32Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pcaresultf32_free(ptr, 0);
    }
    /**
     * Eigenvalues (sample-covariance scale, i.e. divided by (n_samples - 1) when n_samples > 1).
     * @returns {Float32Array}
     */
    get eigenvalues() {
        const ret = wasm.pcaresultf32_eigenvalues(this.__wbg_ptr);
        return ret;
    }
    /**
     * Eigenvectors as flat array (row-major: [pc1_feat1, pc1_feat2, ..., pc2_feat1, ...]).
     * @returns {Float32Array}
     */
    get eigenvectors() {
        const ret = wasm.pcaresultf32_eigenvectors(this.__wbg_ptr);
        return ret;
    }
    /**
     * Mean vector used for centering.
     * @returns {Float32Array}
     */
    get mean() {
        const ret = wasm.pcaresultf32_mean(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get n_components() {
        const ret = wasm.pcaresultf32_n_components(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get n_features() {
        const ret = wasm.pcaresultf32_n_features(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Total variance of centered data (sample-covariance scale).
     * @returns {number}
     */
    get total_variance() {
        const ret = wasm.pcaresultf32_total_variance(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) PCAResultF32.prototype[Symbol.dispose] = PCAResultF32.prototype.free;

/**
 * Result of repeat detection
 */
export class RepeatResult {
    static __wrap(ptr) {
        const obj = Object.create(RepeatResult.prototype);
        obj.__wbg_ptr = ptr;
        RepeatResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RepeatResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_repeatresult_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.repeatresult_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) RepeatResult.prototype[Symbol.dispose] = RepeatResult.prototype.free;

/**
 * A handle to a sequence stored in WASM memory.
 *
 * This struct stores an encoded DNA sequence once and exposes fast methods
 * for various analyses without re-copying the sequence each call.
 *
 * # Usage
 *
 * ```js
 * const handle = SequenceHandle.new(sequenceBytes);
 * try {
 *   const gcSkew = handle.gc_skew(100, 10);
 *   const kmerCounts = handle.count_kmers(4);
 *   // ... use results
 * } finally {
 *   handle.free(); // MUST call to release WASM memory
 * }
 * ```
 *
 * # Memory Management
 *
 * The caller MUST call `.free()` when done to release WASM memory.
 * Failing to do so will leak memory.
 *
 * @see phage_explorer-8qk2.5
 */
export class SequenceHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SequenceHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sequencehandle_free(ptr, 0);
    }
    /**
     * Count k-mers using dense array (for k <= 10).
     *
     * Returns a DenseKmerResult with counts for all 4^k possible k-mers.
     * K-mers containing N are skipped.
     *
     * # Arguments
     * * `k` - K-mer size (1-10)
     *
     * # Returns
     * DenseKmerResult with counts, or empty result if k is invalid.
     * @param {number} k
     * @returns {DenseKmerResult}
     */
    count_kmers(k) {
        const ret = wasm.sequencehandle_count_kmers(this.__wbg_ptr, k);
        return DenseKmerResult.__wrap(ret);
    }
    /**
     * Compute cumulative GC skew.
     *
     * Running sum of (G - C) / (G + C) contribution per base.
     * The cumulative skew typically shows the origin (minimum) and terminus (maximum)
     * of replication for circular genomes.
     *
     * # Returns
     * Float64Array with cumulative skew at each position.
     * @returns {Float64Array}
     */
    cumulative_gc_skew() {
        const ret = wasm.sequencehandle_cumulative_gc_skew(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Compute self-similarity dot plot using pre-encoded sequence.
     *
     * This is more efficient than `dotplot_self_buffers` when running multiple
     * analyses on the same sequence (e.g., progressive refinement with preview
     * then full resolution).
     *
     * # Arguments
     * * `bins` - Number of bins for the grid (bins × bins output)
     * * `window` - Window size in bases. If 0, derives a conservative default.
     *
     * # Returns
     * DotPlotBuffers containing direct and inverted similarity matrices.
     *
     * @see phage_explorer-8qk2.6
     * @param {number} bins
     * @param {number} window
     * @returns {DotPlotBuffers}
     */
    dotplot_self(bins, window) {
        const ret = wasm.sequencehandle_dotplot_self(this.__wbg_ptr, bins, window);
        return DotPlotBuffers.__wrap(ret);
    }
    /**
     * Get the encoded sequence as a Uint8Array.
     *
     * Values: A=0, C=1, G=2, T=3, N=4
     *
     * This is useful for passing to other WASM functions or for debugging.
     * @returns {Uint8Array}
     */
    get encoded_bytes() {
        const ret = wasm.sequencehandle_encoded_bytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * Compute GC skew values for sliding windows.
     *
     * GC skew = (G - C) / (G + C) for each window.
     * Returns an empty array if window_size or step_size is 0, or if
     * the sequence is shorter than window_size.
     *
     * # Arguments
     * * `window_size` - Size of the sliding window
     * * `step_size` - Step between windows
     *
     * # Returns
     * Float64Array of GC skew values, one per window position.
     * @param {number} window_size
     * @param {number} step_size
     * @returns {Float64Array}
     */
    gc_skew(window_size, step_size) {
        const ret = wasm.sequencehandle_gc_skew(this.__wbg_ptr, window_size, step_size);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get the original sequence length.
     * @returns {number}
     */
    get length() {
        const ret = wasm.sequencehandle_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Compute MinHash signature for similarity estimation.
     *
     * Uses canonical k-mers (lexicographically smaller of forward/reverse complement)
     * for strand-independent comparison.
     *
     * # Arguments
     * * `num_hashes` - Number of hash functions (signature size)
     * * `k` - K-mer size
     *
     * # Returns
     * MinHashSignature containing the signature.
     * @param {number} num_hashes
     * @param {number} k
     * @returns {MinHashSignature}
     */
    minhash(num_hashes, k) {
        const ret = wasm.sequencehandle_minhash(this.__wbg_ptr, num_hashes, k);
        return MinHashSignature.__wrap(ret);
    }
    /**
     * Create a new SequenceHandle from raw sequence bytes.
     *
     * The sequence is encoded into a compact representation stored in WASM memory.
     * Case-insensitive: a/A, c/C, g/G, t/T are all valid.
     * U is treated as T. Ambiguous/invalid bases are stored as N (code 4).
     *
     * # Arguments
     * * `seq_bytes` - ASCII bytes of the DNA/RNA sequence
     *
     * # Returns
     * A new SequenceHandle that must be freed with `.free()` when done.
     * @param {Uint8Array} seq_bytes
     */
    constructor(seq_bytes) {
        const ptr0 = passArray8ToWasm0(seq_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sequencehandle_new(ptr0, len0);
        this.__wbg_ptr = ret;
        SequenceHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get the count of valid (non-N) bases.
     * @returns {number}
     */
    get valid_count() {
        const ret = wasm.sequencehandle_valid_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Compute windowed Shannon entropy (normalized 0..=1) for sliding windows.
     * @param {number} window_size
     * @param {number} step_size
     * @returns {Float64Array}
     */
    windowed_entropy(window_size, step_size) {
        const ret = wasm.sequencehandle_windowed_entropy(this.__wbg_ptr, window_size, step_size);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) SequenceHandle.prototype[Symbol.dispose] = SequenceHandle.prototype.free;

/**
 * @param {string} sequence_a
 * @param {string} sequence_b
 * @param {number} k
 * @returns {KmerAnalysisResult}
 */
export function analyze_kmers(sequence_a, sequence_b, k) {
    const ptr0 = passStringToWasm0(sequence_a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(sequence_b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.analyze_kmers(ptr0, len0, ptr1, len1, k);
    return KmerAnalysisResult.__wrap(ret);
}

/**
 * Calculate GC content percentage.
 *
 * Only counts unambiguous A, T, G, C bases. N and other ambiguity codes
 * are excluded from both numerator and denominator.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 *
 * # Returns
 * GC content as percentage (0-100). Returns 0 if no valid bases.
 * @param {string} seq
 * @returns {number}
 */
export function calculate_gc_content(seq) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.calculate_gc_content(ptr0, len0);
    return ret;
}

/**
 * Compute Chaos Game Representation (CGR) counts for a sequence.
 *
 * Semantics match `packages/core/src/analysis/cgr.ts`:
 * - Non-ACGT characters are skipped (no state update).
 * - "Transient removal" uses the raw index: we only start plotting after `i >= k-1`,
 *   where `i` is the index in the *original* input (including skipped chars).
 *
 * # Inputs
 * - `seq_bytes`: ASCII DNA/RNA bytes OR already-encoded ACGT05 (0..=4).
 * - `k`: CGR depth (resolution = 2^k). k=0 yields a 1x1 grid.
 *
 * # Outputs
 * - Dense grid counts as `Uint32Array` (row-major, length = resolution*resolution)
 * - Metadata: resolution, max_count, total_points, entropy (Shannon, base2)
 * @param {Uint8Array} seq_bytes
 * @param {number} k
 * @returns {CgrCountsResult}
 */
export function cgr_counts(seq_bytes, k) {
    const ptr0 = passArray8ToWasm0(seq_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cgr_counts(ptr0, len0, k);
    return CgrCountsResult.__wrap(ret);
}

/**
 * Compute cumulative GC skew (useful for visualizing replication origin).
 *
 * The cumulative skew will have a minimum at the origin of replication
 * and maximum at the terminus.
 * @param {string} seq
 * @returns {Float64Array}
 */
export function compute_cumulative_gc_skew(seq) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_cumulative_gc_skew(ptr0, len0);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * Compute diff mask between two sequences.
 *
 * **STATUS: NOT WIRED IN** - Diff computation happens in JS.
 * Kept for future optimization if diff mode becomes a performance concern.
 * Diff is computed once per sequence change, not per frame, so JS is adequate.
 *
 * Compares a query sequence against a reference sequence and produces
 * a diff mask indicating the type of difference at each position:
 * - 0: Match
 * - 1: Mismatch (substitution)
 * - 2: Insertion (in query relative to ref - not computed here, placeholder)
 * - 3: Deletion (in query relative to ref - not computed here, placeholder)
 *
 * For simple pairwise comparison without alignment, only 0 and 1 are used.
 *
 * # Arguments
 * * `query` - Query sequence (the one being displayed)
 * * `reference` - Reference sequence to compare against
 *
 * # Returns
 * Uint8Array with diff codes (0 = match, 1 = mismatch)
 * @param {string} query
 * @param {string} reference
 * @returns {Uint8Array}
 */
export function compute_diff_mask(query, reference) {
    const ptr0 = passStringToWasm0(query, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(reference, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.compute_diff_mask(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Compute diff mask from pre-encoded sequences (faster than string version).
 *
 * **STATUS: NOT WIRED IN** - See `compute_diff_mask` above.
 * This is the faster variant that operates on pre-encoded sequences.
 *
 * # Arguments
 * * `query_encoded` - Pre-encoded query sequence (values 0-4)
 * * `ref_encoded` - Pre-encoded reference sequence (values 0-4)
 *
 * # Returns
 * Uint8Array with diff codes (0 = match, 1 = mismatch)
 * @param {Uint8Array} query_encoded
 * @param {Uint8Array} ref_encoded
 * @returns {Uint8Array}
 */
export function compute_diff_mask_encoded(query_encoded, ref_encoded) {
    const ptr0 = passArray8ToWasm0(query_encoded, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(ref_encoded, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.compute_diff_mask_encoded(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Compute GC skew using a sliding window.
 *
 * GC skew = (G - C) / (G + C)
 *
 * GC skew is used to identify the origin and terminus of replication in
 * bacterial genomes. Positive skew indicates leading strand, negative
 * indicates lagging strand.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `window_size` - Size of sliding window
 * * `step_size` - Step between windows (1 for maximum resolution)
 *
 * # Returns
 * Array of GC skew values for each window position.
 * @param {string} seq
 * @param {number} window_size
 * @param {number} step_size
 * @returns {Float64Array}
 */
export function compute_gc_skew(seq, window_size, step_size) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_gc_skew(ptr0, len0, window_size, step_size);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * Compute linguistic complexity of a sequence.
 *
 * Linguistic complexity = (number of distinct substrings) / (maximum possible substrings)
 *
 * This measures how "random" or information-rich a sequence is.
 * Low complexity indicates repetitive regions.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `max_k` - Maximum substring length to consider
 *
 * # Returns
 * Complexity score in range [0, 1] where 1 = maximum complexity.
 * @param {string} seq
 * @param {number} max_k
 * @returns {number}
 */
export function compute_linguistic_complexity(seq, max_k) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_linguistic_complexity(ptr0, len0, max_k);
    return ret;
}

/**
 * Compute color runs for micro batch rendering.
 *
 * **STATUS: NOT WIRED IN** - JS `renderMicroBatch()` is used instead.
 * Kept for future optimization if profiling shows rendering is a bottleneck.
 * The JS version already uses the same single-pass algorithm and achieves 60fps.
 *
 * This performs single-pass run-length encoding on an encoded sequence,
 * producing runs grouped by color. The output is a flat Float32Array where
 * every 4 values represent: [color_code, row_y, x, width].
 *
 * Runs are sorted by color so the JS renderer only needs 5 fillStyle changes.
 *
 * # Arguments
 * * `encoded` - Pre-encoded sequence (values 0-4)
 * * `start_row` - First visible row index
 * * `end_row` - Last visible row index (exclusive)
 * * `cols` - Number of columns per row
 * * `cell_width` - Width of each cell in pixels
 * * `cell_height` - Height of each cell in pixels
 * * `offset_y` - Y offset for first visible row (sub-pixel scrolling)
 * * `start_row_offset` - startRow value from visible range (for row Y calculation)
 *
 * # Returns
 * Float32Array with runs: [color, y, x, width, color, y, x, width, ...]
 * First value is the total number of runs.
 * @param {Uint8Array} encoded
 * @param {number} start_row
 * @param {number} end_row
 * @param {number} cols
 * @param {number} cell_width
 * @param {number} cell_height
 * @param {number} offset_y
 * @param {number} start_row_offset
 * @returns {Float32Array}
 */
export function compute_micro_runs(encoded, start_row, end_row, cols, cell_width, cell_height, offset_y, start_row_offset) {
    const ptr0 = passArray8ToWasm0(encoded, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_micro_runs(ptr0, len0, start_row, end_row, cols, cell_width, cell_height, offset_y, start_row_offset);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Compute local complexity in sliding windows.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `window_size` - Size of sliding window
 * * `step_size` - Step between windows
 * * `k` - K-mer size for complexity calculation
 *
 * # Returns
 * Array of complexity values for each window.
 * @param {string} seq
 * @param {number} window_size
 * @param {number} step_size
 * @param {number} k
 * @returns {Float64Array}
 */
export function compute_windowed_complexity(seq, window_size, step_size, k) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_windowed_complexity(ptr0, len0, window_size, step_size, k);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * Compute normalized Shannon entropy (0..=1) in sliding windows over A/C/G/T bases.
 *
 * Semantics match `packages/web/src/workers/analysis.worker.ts`:
 * - Non-ACGT bases are ignored (do not contribute to counts/total).
 * - Windows are taken at starts `i = 0, step, 2*step, ...` while `i < n - window_size`
 *   (note: this intentionally excludes the final full window at `i = n - window_size`).
 * - Output values are Shannon entropy in bits divided by 2 (max for 4 symbols).
 *
 * # Arguments
 * * `seq` - DNA sequence string (case-insensitive; U treated as T).
 * * `window_size` - Size of each window.
 * * `step_size` - Step between windows.
 *
 * # Returns
 * Array of normalized entropy values (0..=1), one per window.
 * @param {string} seq
 * @param {number} window_size
 * @param {number} step_size
 * @returns {Float64Array}
 */
export function compute_windowed_entropy_acgt(seq, window_size, step_size) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_windowed_entropy_acgt(ptr0, len0, window_size, step_size);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * Count codon usage in a DNA sequence.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `frame` - Reading frame (0, 1, or 2)
 *
 * # Returns
 * CodonUsageResult with JSON-encoded codon counts.
 * @param {string} seq
 * @param {number} frame
 * @returns {CodonUsageResult}
 */
export function count_codon_usage(seq, frame) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.count_codon_usage(ptr0, len0, frame);
    return CodonUsageResult.__wrap(ret);
}

/**
 * Dense k-mer counting with typed array output.
 *
 * Uses a rolling 2-bit index algorithm with no per-position heap allocations.
 * Ambiguous bases (N and non-ACGT) reset the rolling state.
 *
 * # Arguments
 * * `seq` - Sequence as bytes (ASCII). Accepts both upper and lower case.
 * * `k` - K-mer size. Must be 1 <= k <= 10 (4^10 = ~4MB max array).
 *
 * # Returns
 * `DenseKmerResult` with:
 * - `counts`: Uint32Array of length 4^k (dense count vector)
 * - `total_valid`: Total valid k-mers counted
 * - `k`: K value used
 * - `unique_count`: Number of unique k-mers observed
 *
 * Returns an empty result with all-zero counts if k is invalid.
 *
 * # Ownership
 * Caller must call `.free()` when done to release WASM memory.
 *
 * # Ambiguous Bases
 * Windows containing non-ACGT bases are skipped. The rolling state resets
 * on any ambiguous base, so no k-mer spans an N.
 *
 * # Example (from JS)
 * ```js
 * const result = wasm.count_kmers_dense(sequenceBytes, 6);
 * try {
 *   const counts = result.counts; // Uint32Array[4096]
 *   const total = result.total_valid;
 *   // Use counts...
 * } finally {
 *   result.free(); // Required!
 * }
 * ```
 *
 * # Determinism
 * Output is fully deterministic. No random number generation.
 *
 * @see phage_explorer-vk7b.1.1
 * @see docs/WASM_ABI_SPEC.md
 * @param {Uint8Array} seq
 * @param {number} k
 * @returns {DenseKmerResult}
 */
export function count_kmers_dense(seq, k) {
    const ptr0 = passArray8ToWasm0(seq, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.count_kmers_dense(ptr0, len0, k);
    return DenseKmerResult.__wrap(ret);
}

/**
 * Dense k-mer counting with reverse complement combined.
 *
 * Counts both forward and reverse complement k-mers into the same array.
 * Uses canonical k-mers (min of forward and RC) for strand-independent analysis.
 *
 * # Arguments
 * * `seq` - Sequence as bytes (ASCII)
 * * `k` - K-mer size (1 <= k <= 10)
 *
 * # Returns
 * `DenseKmerResult` with combined forward + RC counts.
 *
 * # Note
 * For odd k values, forward and RC k-mers are always different.
 * For even k values, some palindromic k-mers are their own RC.
 * @param {Uint8Array} seq
 * @param {number} k
 * @returns {DenseKmerResult}
 */
export function count_kmers_dense_canonical(seq, k) {
    const ptr0 = passArray8ToWasm0(seq, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.count_kmers_dense_canonical(ptr0, len0, k);
    return DenseKmerResult.__wrap(ret);
}

/**
 * Detect bonds using spatial hashing for O(N) complexity.
 *
 * This is the CRITICAL optimization replacing the O(N²) algorithm.
 * For a 50,000 atom structure:
 * - Old: 1.25 billion comparisons → 30-60+ seconds
 * - New: ~1 million comparisons → <1 second
 *
 * # Arguments
 * * `positions` - Flat array of atom positions [x0, y0, z0, x1, y1, z1, ...]
 * * `elements` - String of element symbols (one char per atom: "CCCCNNO...")
 *
 * # Returns
 * BondDetectionResult with pairs of bonded atom indices.
 *
 * # Algorithm
 * 1. Build spatial hash with cell size = max bond distance (~2.7Å)
 * 2. For each atom, only check atoms in neighboring 27 cells
 * 3. Reduces O(N²) to O(N * k) where k ≈ 20 atoms per neighborhood
 * @param {Float32Array} positions
 * @param {string} elements
 * @returns {BondDetectionResult}
 */
export function detect_bonds_spatial(positions, elements) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(elements, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.detect_bonds_spatial(ptr0, len0, ptr1, len1);
    return BondDetectionResult.__wrap(ret);
}

/**
 * Detect functional groups (aromatic rings, disulfides, phosphates) using WASM.
 *
 * This replaces the O(N²) JavaScript implementation with an optimized Rust version.
 * The adjacency list is built once and reused for all detection algorithms.
 *
 * # Arguments
 * * `positions` - Flat array of atom positions [x0, y0, z0, x1, y1, z1, ...]
 * * `elements` - String of element symbols (one char per atom: "CCCCNNO...")
 * * `bonds` - Flat array of bond pairs [a0, b0, a1, b1, ...] from detect_bonds_spatial
 *
 * # Returns
 * FunctionalGroupResult with typed arrays for each group type.
 * @param {Float32Array} positions
 * @param {string} elements
 * @param {Uint32Array} bonds
 * @returns {FunctionalGroupResult}
 */
export function detect_functional_groups(positions, elements, bonds) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(elements, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(bonds, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.detect_functional_groups(ptr0, len0, ptr1, len1, ptr2, len2);
    return FunctionalGroupResult.__wrap(ret);
}

/**
 * Detect palindromic (inverted repeat) sequences in DNA.
 *
 * A palindrome in DNA is a sequence that reads the same on the complementary
 * strand in reverse (e.g., GAATTC and its complement CTTAAG reversed).
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `min_len` - Minimum palindrome arm length (typically 4-6)
 * * `max_gap` - Maximum gap/spacer between palindrome arms (0 for perfect palindromes)
 *
 * # Returns
 * RepeatResult with JSON array of {start, end, arm_length, gap, sequence}
 * @param {string} seq
 * @param {number} min_len
 * @param {number} max_gap
 * @param {number | null} [max_results]
 * @returns {RepeatResult}
 */
export function detect_palindromes(seq, min_len, max_gap, max_results) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.detect_palindromes(ptr0, len0, min_len, max_gap, isLikeNone(max_results) ? Number.MAX_SAFE_INTEGER : (max_results) >>> 0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return RepeatResult.__wrap(ret[0]);
}

/**
 * Detect tandem repeats (consecutive copies of a pattern).
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `min_unit` - Minimum repeat unit length
 * * `max_unit` - Maximum repeat unit length
 * * `min_copies` - Minimum number of consecutive copies
 *
 * # Returns
 * RepeatResult with JSON array of {start, end, unit, copies, sequence}
 * @param {string} seq
 * @param {number} min_unit
 * @param {number} max_unit
 * @param {number} min_copies
 * @param {number | null} [max_results]
 * @returns {RepeatResult}
 */
export function detect_tandem_repeats(seq, min_unit, max_unit, min_copies, max_results) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.detect_tandem_repeats(ptr0, len0, min_unit, max_unit, min_copies, isLikeNone(max_results) ? Number.MAX_SAFE_INTEGER : (max_results) >>> 0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return RepeatResult.__wrap(ret[0]);
}

/**
 * Compute dotplot identity buffers for a sequence against itself.
 *
 * Matches the semantics of `packages/core/src/analysis/dot-plot.ts` but avoids substring
 * allocations and object-heavy grids by returning flat typed arrays.
 *
 * # Arguments
 * * `seq` - Sequence bytes (ASCII). Case-insensitive, U treated as T.
 * * `bins` - Plot resolution (bins x bins). If 0, returns empty buffers.
 * * `window` - Window size in bases. If 0, derives a conservative default similar to JS.
 *
 * # Output layout
 * Row-major, with index `i*bins + j`.
 * @param {Uint8Array} seq
 * @param {number} bins
 * @param {number} window
 * @returns {DotPlotBuffers}
 */
export function dotplot_self_buffers(seq, bins, window) {
    const ptr0 = passArray8ToWasm0(seq, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dotplot_self_buffers(ptr0, len0, bins, window);
    return DotPlotBuffers.__wrap(ret);
}

/**
 * Fast sequence encoding for canvas rendering.
 *
 * **STATUS: NOT WIRED IN** - JS `encodeSequence()` is used instead.
 * Kept for future optimization if profiling shows encoding is a bottleneck.
 *
 * Encodes nucleotide characters to numeric codes:
 * - A/a -> 0, C/c -> 1, G/g -> 2, T/t/U/u -> 3, other -> 4 (N)
 *
 * This would be used by CanvasSequenceGridRenderer for O(1) lookups during rendering.
 * WASM version is ~4x faster than JS for large sequences due to tighter loops,
 * but encoding only happens once per sequence change (not per frame).
 *
 * # Arguments
 * * `seq` - DNA/RNA sequence string
 *
 * # Returns
 * Uint8Array with encoded values (0-4)
 * @param {string} seq
 * @returns {Uint8Array}
 */
export function encode_sequence_fast(seq) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_sequence_fast(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Fast equal-length diff for sequences with only substitutions.
 *
 * This is O(n) and much faster than Myers when we know there are no indels.
 * Use this when sequences are already aligned or have equal length.
 *
 * # Arguments
 * * `seq_a` - First sequence (bytes)
 * * `seq_b` - Second sequence (bytes)
 *
 * # Returns
 * MyersDiffResult with mask codes 0=MATCH, 1=MISMATCH only.
 * @param {Uint8Array} seq_a
 * @param {Uint8Array} seq_b
 * @returns {MyersDiffResult}
 */
export function equal_len_diff(seq_a, seq_b) {
    const ptr0 = passArray8ToWasm0(seq_a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(seq_b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.equal_len_diff(ptr0, len0, ptr1, len1);
    return MyersDiffResult.__wrap(ret);
}

/**
 * Get the maximum allowed k for dense k-mer counting.
 * @returns {number}
 */
export function get_dense_kmer_max_k() {
    const ret = wasm.get_dense_kmer_max_k();
    return ret >>> 0;
}

/**
 * Render a Hilbert curve visualization as a flat RGBA buffer.
 *
 * # Inputs
 * - `seq_bytes`: ASCII DNA/RNA bytes OR already-encoded ACGT05 (0..=4).
 * - `order`: Hilbert order (grid size = 2^order). Must be within guardrails.
 * - `colors_rgb`: packed RGB palette for [A,C,G,T,N] as 15 bytes.
 *
 * # Output
 * - `Vec<u8>` interpreted as RGBA bytes (length = (2^order)^2 * 4).
 *
 * # Guardrails
 * - Caps order to avoid OOM. Returns an empty vec if requested output would exceed limits.
 * @param {Uint8Array} seq_bytes
 * @param {number} order
 * @param {Uint8Array} colors_rgb
 * @returns {Uint8Array}
 */
export function hilbert_rgba(seq_bytes, order, colors_rgb) {
    const ptr0 = passArray8ToWasm0(seq_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(colors_rgb, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.hilbert_rgba(ptr0, len0, order, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Compute Hoeffding's D statistic for measuring statistical dependence.
 *
 * Hoeffding's D is a non-parametric measure of association that can detect
 * any type of dependence (linear or non-linear) between two variables.
 * Unlike Pearson correlation (linear only) or Spearman/Kendall (monotonic),
 * Hoeffding's D can detect complex non-monotonic relationships.
 *
 * # Arguments
 * * `x` - First vector of observations (as a JS Float64Array)
 * * `y` - Second vector of observations (must have same length as x)
 *
 * # Returns
 * HoeffdingResult containing the D statistic and sample size.
 * D ranges approximately from -0.5 to 1, where:
 * - D ≈ 0: variables are independent
 * - D > 0: variables are dependent
 * - D = 1: perfect dependence
 *
 * # Performance
 * O(n²) time complexity. For very large vectors (n > 10000), consider
 * sampling or using approximate methods.
 *
 * # Example Use Cases for Genome Analysis
 * - Compare k-mer frequency vectors between genomes
 * - Detect non-linear relationships in GC content distributions
 * - Measure codon usage similarity accounting for complex dependencies
 * @param {Float64Array} x
 * @param {Float64Array} y
 * @returns {HoeffdingResult}
 */
export function hoeffdings_d(x, y) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(y, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.hoeffdings_d(ptr0, len0, ptr1, len1);
    return HoeffdingResult.__wrap(ret);
}

export function init_panic_hook() {
    wasm.init_panic_hook();
}

/**
 * Check if a k value is valid for dense k-mer counting.
 *
 * Returns true if 1 <= k <= DENSE_KMER_MAX_K (10).
 * @param {number} k
 * @returns {boolean}
 */
export function is_valid_dense_kmer_k(k) {
    const ret = wasm.is_valid_dense_kmer_k(k);
    return ret !== 0;
}

/**
 * Compute Jensen-Shannon Divergence between two probability distributions.
 *
 * JSD(P || Q) = 0.5 * KL(P || M) + 0.5 * KL(Q || M)
 * where M = 0.5 * (P + Q)
 *
 * This is a symmetric and bounded (0 to 1 when using log2) divergence measure.
 *
 * # Arguments
 * * `p` - First probability distribution
 * * `q` - Second probability distribution (must have same length as p)
 *
 * # Returns
 * JSD value in range [0, 1]. Returns 0 if inputs are identical, 1 if completely different.
 * @param {Float64Array} p
 * @param {Float64Array} q
 * @returns {number}
 */
export function jensen_shannon_divergence(p, q) {
    const ptr0 = passArrayF64ToWasm0(p, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(q, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.jensen_shannon_divergence(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Compute JSD between two count arrays.
 * Normalizes to probabilities internally.
 * @param {Float64Array} counts_a
 * @param {Float64Array} counts_b
 * @returns {number}
 */
export function jensen_shannon_divergence_from_counts(counts_a, counts_b) {
    const ptr0 = passArrayF64ToWasm0(counts_a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(counts_b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.jensen_shannon_divergence_from_counts(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Compute Kullback-Leibler divergence between two dense k-mer count arrays.
 *
 * D_KL(P || Q) = sum(P(i) * log2(P(i) / Q(i)))
 *
 * Both arrays are normalized internally to probability distributions.
 * Missing k-mers in Q are smoothed with epsilon to avoid log(0).
 *
 * # Arguments
 * * `p_counts` - Dense count array for distribution P (window)
 * * `q_counts` - Dense count array for distribution Q (background)
 *
 * # Returns
 * KL divergence value (non-negative). Returns 0.0 if inputs are invalid.
 *
 * # Note
 * Arrays must be the same length. For k-mer analysis, length should be 4^k.
 *
 * @see phage_explorer-vk7b.5
 * @param {Uint32Array} p_counts
 * @param {Uint32Array} q_counts
 * @returns {number}
 */
export function kl_divergence_dense(p_counts, q_counts) {
    const ptr0 = passArray32ToWasm0(p_counts, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(q_counts, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.kl_divergence_dense(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Compute Hoeffding's D between two k-mer frequency vectors derived from sequences.
 *
 * This is a convenience function that:
 * 1. Extracts k-mer frequencies from both sequences
 * 2. Creates aligned frequency vectors for all unique k-mers
 * 3. Computes Hoeffding's D on the frequency vectors
 *
 * # Arguments
 * * `sequence_a` - First DNA sequence
 * * `sequence_b` - Second DNA sequence
 * * `k` - K-mer size (typically 3-7 for genome comparison)
 *
 * # Returns
 * Hoeffding's D statistic measuring dependence between k-mer frequency profiles.
 * Higher values indicate more similar frequency patterns (non-linear similarity).
 * @param {string} sequence_a
 * @param {string} sequence_b
 * @param {number} k
 * @returns {HoeffdingResult}
 */
export function kmer_hoeffdings_d(sequence_a, sequence_b, k) {
    const ptr0 = passStringToWasm0(sequence_a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(sequence_b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.kmer_hoeffdings_d(ptr0, len0, ptr1, len1, k);
    return HoeffdingResult.__wrap(ret);
}

/**
 * @param {string} s1
 * @param {string} s2
 * @returns {number}
 */
export function levenshtein_distance(s1, s2) {
    const ptr0 = passStringToWasm0(s1, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(s2, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.levenshtein_distance(ptr0, len0, ptr1, len1);
    return ret >>> 0;
}

/**
 * @param {string} sequence_a
 * @param {string} sequence_b
 * @param {number} k
 * @param {number} num_hashes
 * @returns {number}
 */
export function min_hash_jaccard(sequence_a, sequence_b, k, num_hashes) {
    const ptr0 = passStringToWasm0(sequence_a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(sequence_b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.min_hash_jaccard(ptr0, len0, ptr1, len1, k, num_hashes);
    return ret;
}

/**
 * Estimate Jaccard similarity between two MinHash signatures.
 *
 * # Arguments
 * * `sig_a` - First signature (Uint32Array)
 * * `sig_b` - Second signature (must have same length as sig_a)
 *
 * # Returns
 * Estimated Jaccard similarity (0.0 to 1.0).
 * Returns 0.0 if signatures have different lengths or are empty.
 * @param {Uint32Array} sig_a
 * @param {Uint32Array} sig_b
 * @returns {number}
 */
export function minhash_jaccard_from_signatures(sig_a, sig_b) {
    const ptr0 = passArray32ToWasm0(sig_a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(sig_b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.minhash_jaccard_from_signatures(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Compute MinHash signature using rolling k-mer index.
 *
 * Uses a rolling 2-bit index algorithm with no per-k-mer string allocations.
 * Much faster than the string-based approach for long sequences.
 *
 * # Arguments
 * * `seq` - Sequence as bytes (ASCII). Case-insensitive, U treated as T.
 * * `k` - K-mer size (no practical limit, uses u64 index)
 * * `num_hashes` - Number of hash functions (signature length)
 *
 * # Returns
 * MinHashSignature with `num_hashes` minimum values.
 *
 * # Algorithm
 * 1. Maintain rolling 64-bit k-mer index (allows k up to 32)
 * 2. For each valid k-mer, compute hash for each seed
 * 3. Track minimum hash value per seed
 * 4. Ambiguous bases reset rolling state (no k-mer spans N)
 * @param {Uint8Array} seq
 * @param {number} k
 * @param {number} num_hashes
 * @returns {MinHashSignature}
 */
export function minhash_signature(seq, k, num_hashes) {
    const ptr0 = passArray8ToWasm0(seq, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.minhash_signature(ptr0, len0, k, num_hashes);
    return MinHashSignature.__wrap(ret);
}

/**
 * Compute MinHash signature using canonical k-mers (strand-independent).
 *
 * For each k-mer position, uses the minimum of forward and reverse complement
 * indices before hashing. This makes the signature identical regardless of
 * which strand the sequence represents.
 *
 * # Arguments
 * * `seq` - Sequence as bytes (ASCII). Case-insensitive, U treated as T.
 * * `k` - K-mer size (capped at 32 for u64 index)
 * * `num_hashes` - Number of hash functions (signature length)
 *
 * # Returns
 * MinHashSignature with strand-independent hashes.
 * @param {Uint8Array} seq
 * @param {number} k
 * @param {number} num_hashes
 * @returns {MinHashSignature}
 */
export function minhash_signature_canonical(seq, k, num_hashes) {
    const ptr0 = passArray8ToWasm0(seq, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.minhash_signature_canonical(ptr0, len0, k, num_hashes);
    return MinHashSignature.__wrap(ret);
}

/**
 * Compute Myers diff between two DNA sequences.
 *
 * Uses the Myers O(ND) algorithm with bounded edit distance for safety.
 * Returns a diff result with masks for both sequences and summary statistics.
 *
 * # Arguments
 * * `seq_a` - First sequence (bytes)
 * * `seq_b` - Second sequence (bytes)
 *
 * # Returns
 * MyersDiffResult with masks and statistics.
 *
 * # Guardrails
 * - Max sequence length: 500,000 bp
 * - Max edit distance: 10,000
 * - If exceeded, returns truncated result with partial stats
 * @param {Uint8Array} seq_a
 * @param {Uint8Array} seq_b
 * @returns {MyersDiffResult}
 */
export function myers_diff(seq_a, seq_b) {
    const ptr0 = passArray8ToWasm0(seq_a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(seq_b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.myers_diff(ptr0, len0, ptr1, len1);
    return MyersDiffResult.__wrap(ret);
}

/**
 * Compute Myers diff with custom edit distance limit.
 *
 * # Arguments
 * * `seq_a` - First sequence (bytes)
 * * `seq_b` - Second sequence (bytes)
 * * `max_d` - Maximum edit distance to compute
 * @param {Uint8Array} seq_a
 * @param {Uint8Array} seq_b
 * @param {number} max_d
 * @returns {MyersDiffResult}
 */
export function myers_diff_with_limit(seq_a, seq_b, max_d) {
    const ptr0 = passArray8ToWasm0(seq_a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(seq_b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.myers_diff_with_limit(ptr0, len0, ptr1, len1, max_d);
    return MyersDiffResult.__wrap(ret);
}

/**
 * Compute PCA using power iteration (f32 data path).
 *
 * This entrypoint is designed to accept JS `Float32Array` inputs without the caller
 * having to upcast to `Float64Array`.
 *
 * Determinism:
 * - Initialization is deterministic (no randomness).
 * - Output eigenvectors are canonicalized to a stable sign (largest-magnitude element is positive).
 * @param {Float32Array} data
 * @param {number} n_samples
 * @param {number} n_features
 * @param {number} n_components
 * @param {number} max_iterations
 * @param {number} tolerance
 * @returns {PCAResultF32}
 */
export function pca_power_iteration_f32(data, n_samples, n_features, n_components, max_iterations, tolerance) {
    const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.pca_power_iteration_f32(ptr0, len0, n_samples, n_features, n_components, max_iterations, tolerance);
    return PCAResultF32.__wrap(ret);
}

/**
 * Compute reverse complement of DNA sequence.
 *
 * Handles all IUPAC ambiguity codes correctly:
 * - Standard: A<->T, G<->C
 * - Ambiguity: R<->Y, K<->M, S<->S, W<->W, B<->V, D<->H, N<->N
 *
 * # Arguments
 * * `seq` - DNA sequence string
 *
 * # Returns
 * Reverse complement sequence (preserving case).
 * @param {string} seq
 * @returns {string}
 */
export function reverse_complement(seq) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.reverse_complement(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Scan a sequence for k-mer KL divergence anomalies.
 *
 * Computes KL divergence of each sliding window against the global
 * sequence background. This is the core computation for anomaly detection.
 *
 * # Arguments
 * * `seq` - Sequence bytes (ASCII DNA)
 * * `k` - K-mer size (1-10)
 * * `window_size` - Size of each window in bases
 * * `step_size` - Step size between windows
 *
 * # Returns
 * `KLScanResult` with:
 * - `kl_values`: Float32Array of KL divergence for each window
 * - `positions`: Uint32Array of window start positions
 * - `window_count`: Number of windows scanned
 *
 * # Performance
 * Uses dense k-mer counting for O(1) k-mer lookups.
 * Avoids string allocations by working directly with byte arrays.
 *
 * # Example (from JS)
 * ```js
 * const seqBytes = new TextEncoder().encode(sequence);
 * const result = wasm.scan_kl_windows(seqBytes, 4, 500, 100);
 * try {
 *   const klValues = result.kl_values; // Float32Array
 *   const positions = result.positions; // Uint32Array
 *   // Process anomalies...
 * } finally {
 *   result.free();
 * }
 * ```
 *
 * @see phage_explorer-vk7b.5
 * @param {Uint8Array} seq
 * @param {number} k
 * @param {number} window_size
 * @param {number} step_size
 * @returns {KLScanResult}
 */
export function scan_kl_windows(seq, k, window_size, step_size) {
    const ptr0 = passArray8ToWasm0(seq, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.scan_kl_windows(ptr0, len0, k, window_size, step_size);
    return KLScanResult.__wrap(ret);
}

/**
 * Compute Shannon entropy from a probability distribution.
 *
 * H(X) = -Σ p(x) * log2(p(x))
 *
 * # Arguments
 * * `probs` - Probability distribution (must sum to ~1.0)
 *
 * # Returns
 * Shannon entropy in bits. Returns 0 for empty or invalid input.
 * @param {Float64Array} probs
 * @returns {number}
 */
export function shannon_entropy(probs) {
    const ptr0 = passArrayF64ToWasm0(probs, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.shannon_entropy(ptr0, len0);
    return ret;
}

/**
 * Compute Shannon entropy from a frequency count array.
 * Converts counts to probabilities internally.
 *
 * # Arguments
 * * `counts` - Array of frequency counts
 *
 * # Returns
 * Shannon entropy in bits.
 * @param {Float64Array} counts
 * @returns {number}
 */
export function shannon_entropy_from_counts(counts) {
    const ptr0 = passArrayF64ToWasm0(counts, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.shannon_entropy_from_counts(ptr0, len0);
    return ret;
}

/**
 * Translate DNA sequence to amino acid sequence.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `frame` - Reading frame (0, 1, or 2)
 *
 * # Returns
 * Amino acid sequence as a string. Unknown codons (containing N) become 'X'.
 * @param {string} seq
 * @param {number} frame
 * @returns {string}
 */
export function translate_sequence(seq, frame) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.translate_sequence(ptr0, len0, frame);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}
export function __wbg___wbindgen_throw_5d9e815e6fdf150f(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg_error_757e9472f8410341(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
}
export function __wbg_length_2ea75db9a3294a06(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_length_31bdaf014f5fbde2(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_length_8768c6f6941913e3(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_new_227d7c05414eb861() {
    const ret = new Error();
    return ret;
}
export function __wbg_new_with_length_5ffeddb9d9fbb96f(arg0) {
    const ret = new Uint8Array(arg0 >>> 0);
    return ret;
}
export function __wbg_new_with_length_867011e49634d0b3(arg0) {
    const ret = new Uint32Array(arg0 >>> 0);
    return ret;
}
export function __wbg_new_with_length_cbf540b1826ead5a(arg0) {
    const ret = new Float32Array(arg0 >>> 0);
    return ret;
}
export function __wbg_set_4063c0b3fc4d4c18(arg0, arg1, arg2) {
    arg0.set(getArrayU32FromWasm0(arg1, arg2));
}
export function __wbg_set_5f2ad37e5e02dc7b(arg0, arg1, arg2) {
    arg0.set(getArrayU8FromWasm0(arg1, arg2));
}
export function __wbg_set_c41f8dbc07a2190f(arg0, arg1, arg2) {
    arg0.set(getArrayF32FromWasm0(arg1, arg2));
}
export function __wbg_stack_3b0d974bbf31e44f(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbindgen_generic_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
const BondDetectionResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_bonddetectionresult_free(ptr, 1));
const CgrCountsResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_cgrcountsresult_free(ptr, 1));
const CodonUsageResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_codonusageresult_free(ptr, 1));
const DenseKmerResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_densekmerresult_free(ptr, 1));
const DotPlotBuffersFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dotplotbuffers_free(ptr, 1));
const FunctionalGroupResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_functionalgroupresult_free(ptr, 1));
const HoeffdingResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hoeffdingresult_free(ptr, 1));
const KLScanResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_klscanresult_free(ptr, 1));
const KmerAnalysisResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_kmeranalysisresult_free(ptr, 1));
const MinHashSignatureFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_minhashsignature_free(ptr, 1));
const MyersDiffResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_myersdiffresult_free(ptr, 1));
const PCAResultF32Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pcaresultf32_free(ptr, 1));
const RepeatResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_repeatresult_free(ptr, 1));
const SequenceHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sequencehandle_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
