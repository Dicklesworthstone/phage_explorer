
let imports = {};
imports['__wbindgen_placeholder__'] = module.exports;

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
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

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
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

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
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
    }
}

let WASM_VECTOR_LEN = 0;

const CodonUsageResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_codonusageresult_free(ptr >>> 0, 1));

const GridResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gridresult_free(ptr >>> 0, 1));

const HoeffdingResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hoeffdingresult_free(ptr >>> 0, 1));

const KmerAnalysisResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_kmeranalysisresult_free(ptr >>> 0, 1));

const Model3DFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_model3d_free(ptr >>> 0, 1));

const PCAResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pcaresult_free(ptr >>> 0, 1));

const RepeatResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_repeatresult_free(ptr >>> 0, 1));

const Vector3Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_vector3_free(ptr >>> 0, 1));

/**
 * Result of codon usage analysis.
 */
class CodonUsageResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
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
exports.CodonUsageResult = CodonUsageResult;

/**
 * Result of grid building for sequence viewport
 */
class GridResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GridResult.prototype);
        obj.__wbg_ptr = ptr;
        GridResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GridResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gridresult_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.gridresult_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) GridResult.prototype[Symbol.dispose] = GridResult.prototype.free;
exports.GridResult = GridResult;

/**
 * Result of Hoeffding's D computation
 */
class HoeffdingResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
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
     * @returns {number}
     */
    get n() {
        const ret = wasm.__wbg_get_hoeffdingresult_n(this.__wbg_ptr);
        return ret >>> 0;
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
exports.HoeffdingResult = HoeffdingResult;

class KmerAnalysisResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
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
    get k() {
        const ret = wasm.__wbg_get_kmeranalysisresult_k(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set k(arg0) {
        wasm.__wbg_set_kmeranalysisresult_k(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get unique_kmers_a() {
        const ret = wasm.__wbg_get_kmeranalysisresult_unique_kmers_a(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set unique_kmers_a(arg0) {
        wasm.__wbg_set_kmeranalysisresult_unique_kmers_a(this.__wbg_ptr, arg0);
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
    set unique_kmers_b(arg0) {
        wasm.__wbg_set_kmeranalysisresult_unique_kmers_b(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get shared_kmers() {
        const ret = wasm.__wbg_get_kmeranalysisresult_shared_kmers(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set shared_kmers(arg0) {
        wasm.__wbg_set_kmeranalysisresult_shared_kmers(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get jaccard_index() {
        const ret = wasm.__wbg_get_hoeffdingresult_d(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set jaccard_index(arg0) {
        wasm.__wbg_set_hoeffdingresult_d(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get containment_a_in_b() {
        const ret = wasm.__wbg_get_kmeranalysisresult_containment_a_in_b(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set containment_a_in_b(arg0) {
        wasm.__wbg_set_kmeranalysisresult_containment_a_in_b(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get containment_b_in_a() {
        const ret = wasm.__wbg_get_kmeranalysisresult_containment_b_in_a(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set containment_b_in_a(arg0) {
        wasm.__wbg_set_kmeranalysisresult_containment_b_in_a(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get cosine_similarity() {
        const ret = wasm.__wbg_get_kmeranalysisresult_cosine_similarity(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set cosine_similarity(arg0) {
        wasm.__wbg_set_kmeranalysisresult_cosine_similarity(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get bray_curtis_dissimilarity() {
        const ret = wasm.__wbg_get_kmeranalysisresult_bray_curtis_dissimilarity(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set bray_curtis_dissimilarity(arg0) {
        wasm.__wbg_set_kmeranalysisresult_bray_curtis_dissimilarity(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) KmerAnalysisResult.prototype[Symbol.dispose] = KmerAnalysisResult.prototype.free;
exports.KmerAnalysisResult = KmerAnalysisResult;

class Model3D {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Model3DFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_model3d_free(ptr, 0);
    }
    /**
     * @param {Float64Array} vertices
     * @param {Uint32Array} edges
     */
    constructor(vertices, edges) {
        const ptr0 = passArrayF64ToWasm0(vertices, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(edges, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.model3d_new(ptr0, len0, ptr1, len1);
        this.__wbg_ptr = ret >>> 0;
        Model3DFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Model3D.prototype[Symbol.dispose] = Model3D.prototype.free;
exports.Model3D = Model3D;

/**
 * Result of PCA computation
 */
class PCAResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PCAResult.prototype);
        obj.__wbg_ptr = ptr;
        PCAResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PCAResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pcaresult_free(ptr, 0);
    }
    /**
     * Number of features
     * @returns {number}
     */
    get n_features() {
        const ret = wasm.pcaresult_n_features(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get eigenvalues
     * @returns {Float64Array}
     */
    get eigenvalues() {
        const ret = wasm.pcaresult_eigenvalues(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get eigenvectors as flat array (row-major: [pc1_feat1, pc1_feat2, ..., pc2_feat1, ...])
     * @returns {Float64Array}
     */
    get eigenvectors() {
        const ret = wasm.pcaresult_eigenvectors(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Number of components
     * @returns {number}
     */
    get n_components() {
        const ret = wasm.pcaresult_n_components(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) PCAResult.prototype[Symbol.dispose] = PCAResult.prototype.free;
exports.PCAResult = PCAResult;

/**
 * Result of repeat detection
 */
class RepeatResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
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
exports.RepeatResult = RepeatResult;

class Vector3 {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Vector3Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_vector3_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get x() {
        const ret = wasm.__wbg_get_vector3_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set x(arg0) {
        wasm.__wbg_set_vector3_x(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get y() {
        const ret = wasm.__wbg_get_vector3_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set y(arg0) {
        wasm.__wbg_set_vector3_y(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get z() {
        const ret = wasm.__wbg_get_vector3_z(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set z(arg0) {
        wasm.__wbg_set_vector3_z(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) Vector3.prototype[Symbol.dispose] = Vector3.prototype.free;
exports.Vector3 = Vector3;

/**
 * @param {string} sequence_a
 * @param {string} sequence_b
 * @param {number} k
 * @returns {KmerAnalysisResult}
 */
function analyze_kmers(sequence_a, sequence_b, k) {
    const ptr0 = passStringToWasm0(sequence_a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(sequence_b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.analyze_kmers(ptr0, len0, ptr1, len1, k);
    return KmerAnalysisResult.__wrap(ret);
}
exports.analyze_kmers = analyze_kmers;

/**
 * Build a grid of sequence data for viewport rendering.
 *
 * This is the HOT PATH called on every scroll. Optimized for minimal
 * allocations and fast character processing.
 *
 * # Arguments
 * * `seq` - Full sequence string
 * * `start_index` - Starting position in sequence (0-based)
 * * `cols` - Number of columns in grid
 * * `rows` - Number of rows in grid
 * * `mode` - Display mode: "dna", "aa", or "dual"
 * * `frame` - Reading frame for AA translation (0, 1, or 2)
 *
 * # Returns
 * GridResult with JSON-encoded rows, each containing:
 * - cells: array of {char, phase, is_stop, is_start} for DNA mode
 * - cells: array of {char, codon, is_stop, is_start} for AA mode
 * @param {string} seq
 * @param {number} start_index
 * @param {number} cols
 * @param {number} rows
 * @param {string} mode
 * @param {number} frame
 * @returns {GridResult}
 */
function build_grid(seq, start_index, cols, rows, mode, frame) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.build_grid(ptr0, len0, start_index, cols, rows, ptr1, len1, frame);
    return GridResult.__wrap(ret);
}
exports.build_grid = build_grid;

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
function calculate_gc_content(seq) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.calculate_gc_content(ptr0, len0);
    return ret;
}
exports.calculate_gc_content = calculate_gc_content;

/**
 * Compute cumulative GC skew (useful for visualizing replication origin).
 *
 * The cumulative skew will have a minimum at the origin of replication
 * and maximum at the terminus.
 * @param {string} seq
 * @returns {Float64Array}
 */
function compute_cumulative_gc_skew(seq) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_cumulative_gc_skew(ptr0, len0);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}
exports.compute_cumulative_gc_skew = compute_cumulative_gc_skew;

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
function compute_gc_skew(seq, window_size, step_size) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_gc_skew(ptr0, len0, window_size, step_size);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}
exports.compute_gc_skew = compute_gc_skew;

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
function compute_linguistic_complexity(seq, max_k) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_linguistic_complexity(ptr0, len0, max_k);
    return ret;
}
exports.compute_linguistic_complexity = compute_linguistic_complexity;

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
function compute_windowed_complexity(seq, window_size, step_size, k) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_windowed_complexity(ptr0, len0, window_size, step_size, k);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}
exports.compute_windowed_complexity = compute_windowed_complexity;

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
function count_codon_usage(seq, frame) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.count_codon_usage(ptr0, len0, frame);
    return CodonUsageResult.__wrap(ret);
}
exports.count_codon_usage = count_codon_usage;

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
 * @returns {RepeatResult}
 */
function detect_palindromes(seq, min_len, max_gap) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.detect_palindromes(ptr0, len0, min_len, max_gap);
    return RepeatResult.__wrap(ret);
}
exports.detect_palindromes = detect_palindromes;

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
 * @returns {RepeatResult}
 */
function detect_tandem_repeats(seq, min_unit, max_unit, min_copies) {
    const ptr0 = passStringToWasm0(seq, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.detect_tandem_repeats(ptr0, len0, min_unit, max_unit, min_copies);
    return RepeatResult.__wrap(ret);
}
exports.detect_tandem_repeats = detect_tandem_repeats;

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
function hoeffdings_d(x, y) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(y, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.hoeffdings_d(ptr0, len0, ptr1, len1);
    return HoeffdingResult.__wrap(ret);
}
exports.hoeffdings_d = hoeffdings_d;

function init_panic_hook() {
    wasm.init_panic_hook();
}
exports.init_panic_hook = init_panic_hook;

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
function jensen_shannon_divergence(p, q) {
    const ptr0 = passArrayF64ToWasm0(p, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(q, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.jensen_shannon_divergence(ptr0, len0, ptr1, len1);
    return ret;
}
exports.jensen_shannon_divergence = jensen_shannon_divergence;

/**
 * Compute JSD between two count arrays.
 * Normalizes to probabilities internally.
 * @param {Float64Array} counts_a
 * @param {Float64Array} counts_b
 * @returns {number}
 */
function jensen_shannon_divergence_from_counts(counts_a, counts_b) {
    const ptr0 = passArrayF64ToWasm0(counts_a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(counts_b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.jensen_shannon_divergence_from_counts(ptr0, len0, ptr1, len1);
    return ret;
}
exports.jensen_shannon_divergence_from_counts = jensen_shannon_divergence_from_counts;

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
function kmer_hoeffdings_d(sequence_a, sequence_b, k) {
    const ptr0 = passStringToWasm0(sequence_a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(sequence_b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.kmer_hoeffdings_d(ptr0, len0, ptr1, len1, k);
    return HoeffdingResult.__wrap(ret);
}
exports.kmer_hoeffdings_d = kmer_hoeffdings_d;

/**
 * @param {string} s1
 * @param {string} s2
 * @returns {number}
 */
function levenshtein_distance(s1, s2) {
    const ptr0 = passStringToWasm0(s1, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(s2, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.levenshtein_distance(ptr0, len0, ptr1, len1);
    return ret >>> 0;
}
exports.levenshtein_distance = levenshtein_distance;

/**
 * @param {string} sequence_a
 * @param {string} sequence_b
 * @param {number} k
 * @param {number} num_hashes
 * @returns {number}
 */
function min_hash_jaccard(sequence_a, sequence_b, k, num_hashes) {
    const ptr0 = passStringToWasm0(sequence_a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(sequence_b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.min_hash_jaccard(ptr0, len0, ptr1, len1, k, num_hashes);
    return ret;
}
exports.min_hash_jaccard = min_hash_jaccard;

/**
 * Compute PCA using power iteration method.
 *
 * # Arguments
 * * `data` - Flattened row-major matrix (n_samples * n_features)
 * * `n_samples` - Number of samples (rows)
 * * `n_features` - Number of features (columns)
 * * `n_components` - Number of principal components to extract
 * * `max_iterations` - Maximum iterations for power iteration (default: 100)
 * * `tolerance` - Convergence tolerance (default: 1e-8)
 *
 * # Returns
 * PCAResult containing eigenvectors and eigenvalues.
 *
 * # Algorithm
 * Uses power iteration to find top eigenvectors of X^T * X without forming
 * the full covariance matrix. This is memory-efficient for high-dimensional
 * data (e.g., k-mer frequencies with 4^k features).
 * @param {Float64Array} data
 * @param {number} n_samples
 * @param {number} n_features
 * @param {number} n_components
 * @param {number} max_iterations
 * @param {number} tolerance
 * @returns {PCAResult}
 */
function pca_power_iteration(data, n_samples, n_features, n_components, max_iterations, tolerance) {
    const ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.pca_power_iteration(ptr0, len0, n_samples, n_features, n_components, max_iterations, tolerance);
    return PCAResult.__wrap(ret);
}
exports.pca_power_iteration = pca_power_iteration;

/**
 * Renders a 3D model to an ASCII string.
 *
 * # Arguments
 * * `model` - The 3D model to render (vertices and edges).
 * * `rx` - Rotation around X axis (radians).
 * * `ry` - Rotation around Y axis (radians).
 * * `rz` - Rotation around Z axis (radians).
 * * `width` - Target width of the ASCII canvas in characters.
 * * `height` - Target height of the ASCII canvas in characters.
 * * `quality` - Rendering quality/style ("low", "medium", "high", "ultra", "blocks").
 * @param {Model3D} model
 * @param {number} rx
 * @param {number} ry
 * @param {number} rz
 * @param {number} width
 * @param {number} height
 * @param {string} quality
 * @returns {string}
 */
function render_ascii_model(model, rx, ry, rz, width, height, quality) {
    let deferred2_0;
    let deferred2_1;
    try {
        _assertClass(model, Model3D);
        const ptr0 = passStringToWasm0(quality, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.render_ascii_model(model.__wbg_ptr, rx, ry, rz, width, height, ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}
exports.render_ascii_model = render_ascii_model;

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
function reverse_complement(seq) {
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
exports.reverse_complement = reverse_complement;

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
function shannon_entropy(probs) {
    const ptr0 = passArrayF64ToWasm0(probs, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.shannon_entropy(ptr0, len0);
    return ret;
}
exports.shannon_entropy = shannon_entropy;

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
function shannon_entropy_from_counts(counts) {
    const ptr0 = passArrayF64ToWasm0(counts, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.shannon_entropy_from_counts(ptr0, len0);
    return ret;
}
exports.shannon_entropy_from_counts = shannon_entropy_from_counts;

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
function translate_sequence(seq, frame) {
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
exports.translate_sequence = translate_sequence;

exports.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
};

exports.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
};

exports.__wbg_new_8a6f238a6ece86ea = function() {
    const ret = new Error();
    return ret;
};

exports.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
};

exports.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
};

// Inlined Wasm bytes
const wasmBase64 = "AGFzbQEAAAAB6gEhYAJ/fwBgAn9/AX9gA39/fwF/YAN/f38AYAACf39gAX8AYAF/AX9gBH9/f38Bf2AAAGACf3wAYAR/f39/AGAFf39/f38AYAF8AXxgBX9/f39/AX9gAX8BfGAGf39/f39/AGACf38BfGABfwJ/f2AHf39/f39/fwBgAn9/AX5gBH9/f38BfGACf38Cf39gAAFvYAJ/bwBgB39/f39/f3wBf2AIf39/f39/f38Bf2AGf39/f39/AXxgCH98fHx/f39/An9/YAV/f39/fwJ/f2AEf39/fwJ/f2ADf39/An9/YAN/f38BfGAAAX8CpQIFGF9fd2JpbmRnZW5fcGxhY2Vob2xkZXJfXxpfX3diZ19uZXdfOGE2ZjIzOGE2ZWNlODZlYQAWGF9fd2JpbmRnZW5fcGxhY2Vob2xkZXJfXxxfX3diZ19zdGFja18wZWQ3NWQ2ODU3NWIwZjNjABcYX193YmluZGdlbl9wbGFjZWhvbGRlcl9fHF9fd2JnX2Vycm9yXzc1MzRiOGU5YTM2ZjFhYjQAABhfX3diaW5kZ2VuX3BsYWNlaG9sZGVyX18nX193YmdfX193YmluZGdlbl90aHJvd19kZDI0NDE3ZWQzNmZjNDZlAAAYX193YmluZGdlbl9wbGFjZWhvbGRlcl9fH19fd2JpbmRnZW5faW5pdF9leHRlcm5yZWZfdGFibGUACAOzAbEBBgMSEg8KDwsJAwMKAgUDAwMLCgMCDAwHAQADExMABwMQAw0AARAAAwwADQEBAQEHABQQAAACAAsPCwAAAA0YAwEZAAcDAw0ICg0HAgUFBQULDAADBgYCAgIGAgUBCAUAChQDARoBBwcHGwEGCBwdHg4GDg4ODgYGBgYVFQkACQkJCQAAAAAREREfBQUDAQggBQwAAAADAwIBAQEHAAEBAwICAggBAQAICAAAAQECAAUABAkCcAEpKW8AgAEFAwEAEQYJAX8BQYCAwAALB88QSQZtZW1vcnkCABtfX3diZ19jb2RvbnVzYWdlcmVzdWx0X2ZyZWUAOxtfX3diZ19nZXRfaG9lZmZkaW5ncmVzdWx0X2QAdRtfX3diZ19nZXRfaG9lZmZkaW5ncmVzdWx0X24AdjZfX3diZ19nZXRfa21lcmFuYWx5c2lzcmVzdWx0X2JyYXlfY3VydGlzX2Rpc3NpbWlsYXJpdHkAdy9fX3diZ19nZXRfa21lcmFuYWx5c2lzcmVzdWx0X2NvbnRhaW5tZW50X2FfaW5fYgB4L19fd2JnX2dldF9rbWVyYW5hbHlzaXNyZXN1bHRfY29udGFpbm1lbnRfYl9pbl9hAHkuX193YmdfZ2V0X2ttZXJhbmFseXNpc3Jlc3VsdF9jb3NpbmVfc2ltaWxhcml0eQB6Hl9fd2JnX2dldF9rbWVyYW5hbHlzaXNyZXN1bHRfawB7KV9fd2JnX2dldF9rbWVyYW5hbHlzaXNyZXN1bHRfc2hhcmVkX2ttZXJzAHwrX193YmdfZ2V0X2ttZXJhbmFseXNpc3Jlc3VsdF91bmlxdWVfa21lcnNfYQB9K19fd2JnX2dldF9rbWVyYW5hbHlzaXNyZXN1bHRfdW5pcXVlX2ttZXJzX2IAfhVfX3diZ19ncmlkcmVzdWx0X2ZyZWUAOxpfX3diZ19ob2VmZmRpbmdyZXN1bHRfZnJlZQA/HV9fd2JnX2ttZXJhbmFseXNpc3Jlc3VsdF9mcmVlAEAUX193YmdfcGNhcmVzdWx0X2ZyZWUAOBdfX3diZ19yZXBlYXRyZXN1bHRfZnJlZQA7G19fd2JnX3NldF9ob2VmZmRpbmdyZXN1bHRfZACBARtfX3diZ19zZXRfaG9lZmZkaW5ncmVzdWx0X24AggE2X193Ymdfc2V0X2ttZXJhbmFseXNpc3Jlc3VsdF9icmF5X2N1cnRpc19kaXNzaW1pbGFyaXR5AIMBL19fd2JnX3NldF9rbWVyYW5hbHlzaXNyZXN1bHRfY29udGFpbm1lbnRfYV9pbl9iAIQBL19fd2JnX3NldF9rbWVyYW5hbHlzaXNyZXN1bHRfY29udGFpbm1lbnRfYl9pbl9hAIUBLl9fd2JnX3NldF9rbWVyYW5hbHlzaXNyZXN1bHRfY29zaW5lX3NpbWlsYXJpdHkAhgEeX193Ymdfc2V0X2ttZXJhbmFseXNpc3Jlc3VsdF9rAIcBKV9fd2JnX3NldF9rbWVyYW5hbHlzaXNyZXN1bHRfc2hhcmVkX2ttZXJzAIgBK19fd2JnX3NldF9rbWVyYW5hbHlzaXNyZXN1bHRfdW5pcXVlX2ttZXJzX2EAiQErX193Ymdfc2V0X2ttZXJhbmFseXNpc3Jlc3VsdF91bmlxdWVfa21lcnNfYgCKAQ1hbmFseXplX2ttZXJzACcKYnVpbGRfZ3JpZABGFGNhbGN1bGF0ZV9nY19jb250ZW50ACoVY29kb251c2FnZXJlc3VsdF9qc29uAIsBGmNvbXB1dGVfY3VtdWxhdGl2ZV9nY19za2V3AH8PY29tcHV0ZV9nY19za2V3AHMdY29tcHV0ZV9saW5ndWlzdGljX2NvbXBsZXhpdHkAjgEbY29tcHV0ZV93aW5kb3dlZF9jb21wbGV4aXR5AHIRY291bnRfY29kb25fdXNhZ2UAUBJkZXRlY3RfcGFsaW5kcm9tZXMATxVkZXRlY3RfdGFuZGVtX3JlcGVhdHMATg9ncmlkcmVzdWx0X2pzb24AiwEMaG9lZmZkaW5nc19kAEgZamVuc2VuX3NoYW5ub25fZGl2ZXJnZW5jZQA2JWplbnNlbl9zaGFubm9uX2RpdmVyZ2VuY2VfZnJvbV9jb3VudHMAZhFrbWVyX2hvZWZmZGluZ3NfZABLFGxldmVuc2h0ZWluX2Rpc3RhbmNlAGwQbWluX2hhc2hfamFjY2FyZABpE3BjYV9wb3dlcl9pdGVyYXRpb24AQxVwY2FyZXN1bHRfZWlnZW52YWx1ZXMAjAEWcGNhcmVzdWx0X2VpZ2VudmVjdG9ycwCNARZwY2FyZXN1bHRfbl9jb21wb25lbnRzAFkUcGNhcmVzdWx0X25fZmVhdHVyZXMAWhFyZXBlYXRyZXN1bHRfanNvbgCLARJyZXZlcnNlX2NvbXBsZW1lbnQAgAEPc2hhbm5vbl9lbnRyb3B5ADcbc2hhbm5vbl9lbnRyb3B5X2Zyb21fY291bnRzACUSdHJhbnNsYXRlX3NlcXVlbmNlAHQPaW5pdF9wYW5pY19ob29rAGIqX193Ymdfc2V0X2ttZXJhbmFseXNpc3Jlc3VsdF9qYWNjYXJkX2luZGV4AIEBKl9fd2JnX2dldF9rbWVyYW5hbHlzaXNyZXN1bHRfamFjY2FyZF9pbmRleAB1E19fd2JnX2dldF92ZWN0b3IzX3gAdRNfX3diZ19nZXRfdmVjdG9yM195AHgTX193YmdfZ2V0X3ZlY3RvcjNfegB5El9fd2JnX21vZGVsM2RfZnJlZQA5E19fd2JnX3NldF92ZWN0b3IzX3gAgQETX193Ymdfc2V0X3ZlY3RvcjNfeQCEARNf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BHwBfiMAQTBrIgkkAAJAAkAgAb0iJEIgiKciAkH/////B3EiBEH71L2ABE8EQCAEQbyM8YAETwRAAkACQCAEQfvD5IkETwRAIARB//+//wdLDQEgCSAkQv////////8Hg0KAgICAgICAsMEAhL8iAfwCtyIgOQMAIAkgASAgoUQAAAAAAABwQaIiAfwCIgK3IiA5AwggCSABICChRAAAAAAAAHBBoiIBOQMQIAlCADcDKCAJQgA3AyAgCUIANwMYIAlBGGohEiMAQbAEayIDJAAgA0IANwOYASADQgA3A5ABIANCADcDiAEgA0IANwOAASADQgA3A3ggA0IANwNwIANCADcDaCADQgA3A2AgA0IANwNYIANCADcDUCADQgA3A0ggA0IANwNAIANCADcDOCADQgA3AzAgA0IANwMoIANCADcDICADQgA3AxggA0IANwMQIANCADcDCCADQgA3AwAgA0IANwO4AiADQgA3A7ACIANCADcDqAIgA0IANwOgAiADQgA3A5gCIANCADcDkAIgA0IANwOIAiADQgA3A4ACIANCADcD+AEgA0IANwPwASADQgA3A+gBIANCADcD4AEgA0IANwPYASADQgA3A9ABIANCADcDyAEgA0IANwPAASADQgA3A7gBIANCADcDsAEgA0IANwOoASADQgA3A6ABIANCADcD2AMgA0IANwPQAyADQgA3A8gDIANCADcDwAMgA0IANwO4AyADQgA3A7ADIANCADcDqAMgA0IANwOgAyADQgA3A5gDIANCADcDkAMgA0IANwOIAyADQgA3A4ADIANCADcD+AIgA0IANwPwAiADQgA3A+gCIANCADcD4AIgA0IANwPYAiADQgA3A9ACIANCADcDyAIgA0IANwPAAiADQeADakEAQdAA/AsAQeSSwQAoAgAiDEEDQQJBASACGyABRAAAAAAAAAAAYhsiAkEBayILaiEFIARBFHZBlghrIgRBA2tBGG0iBkEAIAZBAEobIg4gC2shBiAOQQJ0IAJBAnRrQfSSwQBqIQhBACECA0AgAyACQQN0aiAGQQBIBHxEAAAAAAAAAAAFIAgoAgC3CzkDACACIAVJIgoEQCAIQQRqIQggBkEBaiEGIAIgCmoiAiAFTQ0BCwtBACEGA0AgBiALaiEFRAAAAAAAAAAAIQFBACECA0ACQCABIAkgAkED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IgJQRQRAIAkoAgghAANAIBEgAnqnQQN2IAVqIAtxIhJBBHRrIhMoAgggAEYEQCAJKAIEIBMoAgQgABBcRQ0DCyACQgF9IAKDIgJQRQ0ACwtBACADIANCAYaDQoCBgoSIkKDAgH+DUEUNAhogBSAMQQhqIgxqIAtxIQUMAQsLIApBACASa0EEdGoLIgBBBGtBACAAGyEACyAOIAZBA3RqIABB+JvAACAAGygCALg5AwAgBkEBaiEGIAFBAWoiASAQRw0ACwsgBjYCAAvnAgEFfwJAIAFBzf97QRAgACAAQRBNGyIAa08NACAAQRAgAUELakF4cSABQQtJGyIEakEMahAFIgJFDQAgAkEIayEBAkAgAEEBayIDIAJxRQRAIAEhAAwBCyACQQRrIgUoAgAiBkF4cSACIANqQQAgAGtxQQhrIgIgAEEAIAIgAWtBEE0baiIAIAFrIgJrIQMgBkEDcQRAIAAgAyAAKAIEQQFxckECcjYCBCAAIANqIgMgAygCBEEBcjYCBCAFIAIgBSgCAEEBcXJBAnI2AgAgASACaiIDIAMoAgRBAXI2AgQgASACECIMAQsgASgCACEBIAAgAzYCBCAAIAEgAmo2AgALAkAgACgCBCIBQQNxRQ0AIAFBeHEiAiAEQRBqTQ0AIAAgBCABQQFxckECcjYCBCAAIARqIgEgAiAEayIEQQNyNgIEIAAgAmoiAiACKAIEQQFyNgIEIAEgBBAiCyAAQQhqIQMLIAMLggUCAn4DfyABRQRARAAAAAAAAAAADwsgAUEDcSEFAn8gAUEESQRAIAAMAQsgAUH8////B3EhBiAAIQQDQAJAAkACQCAELQAAQcEAaw41AQIAAgICAAICAgICAgICAgICAgEBAgICAgICAgICAgIBAgACAgIAAgICAgICAgICAgICAQECCyACQgF8IQIgA0IBfCEDDAELIAJCAXwhAgsCQAJAAkAgBEEBai0AAEHBAGsONQECAAICAgACAgICAgICAgICAgIBAQICAgICAgICAgICAQIAAgICAAICAgICAgICAgICAgEBAgsgAkIBfCECIANCAXwhAwwBCyACQgF8IQILAkACQAJAIARBAmotAABBwQBrDjUAAgECAgIBAgICAgICAgICAgICAAACAgICAgICAgICAgACAQICAgECAgICAgICAgICAgIAAAILIAJC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dGFydCBpbmRleCDAIiBvdXQgb2YgcmFuZ2UgZm9yIHNsaWNlIG9mIGxlbmd0aCDAABByYW5nZSBlbmQgaW5kZXggwCIgb3V0IG9mIHJhbmdlIGZvciBzbGljZSBvZiBsZW5ndGggwABIY2Fubm90IGFjY2VzcyBhIFRocmVhZCBMb2NhbCBTdG9yYWdlIHZhbHVlIGR1cmluZyBvciBhZnRlciBkZXN0cnVjdGlvbjogwADAAjogwAAHeyJyb3ciOsAJLCJzdGFydCI6wAcsImVuZCI6wAosImNlbGxzIjpbwAJdfQAJeyJzdGFydCI6wAcsImVuZCI6wAksInVuaXQiOiLACyIsImNvcGllcyI6wA0sInNlcXVlbmNlIjoiwAIifQAJeyJzdGFydCI6wAcsImVuZCI6wA4sImFybV9sZW5ndGgiOsAHLCJnYXAiOsANLCJzZXF1ZW5jZSI6IsACIn0ACXsiY2hhciI6IsALIiwiY29kb24iOiLACCIsInBvcyI6wAssImlzX3N0b3AiOsAMLCJpc19zdGFydCI6wAF9AAl7ImNoYXIiOiLACCIsInBvcyI6wAksInBoYXNlIjrACywiaXNfc3RvcCI6wAwsImlzX3N0YXJ0IjrAAX0AbGlicmFyeS9jb3JlL3NyYy9zbGljZS9zb3J0L3NoYXJlZC9zbWFsbHNvcnQucnMAL3J1c3RjLzM3YWEyMTM1YjVkMDkzNmJkMTNhYTY5OWQ5NDFhYWE5NGZiYWE2NDUvbGlicmFyeS9jb3JlL3NyYy9zbGljZS9zb3J0L3N0YWJsZS9xdWlja3NvcnQucnMAbGlicmFyeS9hbGxvYy9zcmMvZm10LnJzAC9ydXN0Yy8zN2FhMjEzNWI1ZDA5MzZiZDEzYWE2OTlkOTQxYWFhOTRmYmFhNjQ1L2xpYnJhcnkvc3RkL3NyYy9zeXMvdGhyZWFkX2xvY2FsL25vX3RocmVhZHMucnMAL3J1c3RjLzM3YWEyMTM1YjVkMDkzNmJkMTNhYTY5OWQ5NDFhYWE5NGZiYWE2NDUvbGlicmFyeS9hbGxvYy9zcmMvc3RyLnJzAHNyYy9yZW5kZXJlci5ycwBsaWJyYXJ5L2NvcmUvc3JjL2ZtdC9udW0ucnMAL3J1c3RjLzM3YWEyMTM1YjVkMDkzNmJkMTNhYTY5OWQ5NDFhYWE5NGZiYWE2NDUvbGlicmFyeS9zdGQvc3JjL3RocmVhZC9sb2NhbC5ycwAvcnVzdGMvMzdhYTIxMzViNWQwOTM2YmQxM2FhNjk5ZDk0MWFhYTk0ZmJhYTY0NS9saWJyYXJ5L2FsbG9jL3NyYy9zdHJpbmcucnMAbGlicmFyeS9zdGQvc3JjL3Bhbmlja2luZy5ycwAvaG9tZS91YnVudHUvLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi93YXNtLWJpbmRnZW4tMC4yLjEwNi9zcmMvZXh0ZXJucmVmLnJzAC9ydXN0Yy8zN2FhMjEzNWI1ZDA5MzZiZDEzYWE2OTlkOTQxYWFhOTRmYmFhNjQ1L2xpYnJhcnkvc3RkL3NyYy9zeW5jL29uY2UucnMAL3J1c3QvZGVwcy9oYXNoYnJvd24tMC4xNi4xL3NyYy9yYXcvbW9kLnJzAGxpYnJhcnkvYWxsb2Mvc3JjL3Jhd192ZWMvbW9kLnJzAC9ydXN0Yy8zN2FhMjEzNWI1ZDA5MzZiZDEzYWE2OTlkOTQxYWFhOTRmYmFhNjQ1L2xpYnJhcnkvYWxsb2Mvc3JjL3ZlYy9tb2QucnMAL3J1c3RjLzM3YWEyMTM1YjVkMDkzNmJkMTNhYTY5OWQ5NDFhYWE5NGZiYWE2NDUvbGlicmFyeS9hbGxvYy9zcmMvdmVjL3NwZWNfZnJvbV9pdGVyX25lc3RlZC5ycwAvcnVzdC9kZXBzL2RsbWFsbG9jLTAuMi4xMS9zcmMvZGxtYWxsb2MucnMAbGlicmFyeS9zdGQvc3JjL2FsbG9jLnJzAC9ob21lL3VidW50dS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL2NvbnNvbGVfZXJyb3JfcGFuaWNfaG9vay0wLjEuNy9zcmMvbGliLnJzAGxpYnJhcnkvY29yZS9zcmMvdW5pY29kZS91bmljb2RlX2RhdGEucnMAFW1lbW9yeSBhbGxvY2F0aW9uIG9mIMANIGJ5dGVzIGZhaWxlZAABW8ABXQAAANoGEAAKAAAA6wUAABwAAADaBhAACgAAAPMFAAA0AAAA2gYQAAoAAADzBQAAQgAAACwAAADaBhAACgAA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AABtLAAAUgIAAHAsAABTAgAAgQEAAFQCAACGAQAAVgIAAIkBAABXAgAAigEAAFkCAACPAQAAWwIAAJABAABcAgAAq6cAAGACAACTAQAAYQIAAKynAABjAgAAlAEAAGQCAADLpwAAZQIAAI2nAABmAgAAqqcAAGgCAACXAQAAaQIAAJYBAABqAgAArqcAAGsCAABiLAAAbAIAAK2nAABvAgAAnAEAAHECAABuLAAAcgIAAJ0BAAB1AgAAnwEAAH0CAABkLAAAgAIAAKYBAACCAgAAxacAAIMCAACpAQAAhwIAALGnAACIAgAArgEAAIkCAABEAgAAigIAALEBAACLAgAAsgEAAIwCAABFAgAAkgIAALcBAACdAgAAsqcAAJ4CAACwpwAARQMAAJkDAABxAwAAcAMAAHMDAAByAwAAdwMAAHYDAAB7AwAA/QMAAHwDAAD+AwAAfQMAAP8DAACQAwAAAwBAAKwDAACGAwAArQMAAIgDAACuAwAAiQMAAK8DAACKAwAAsAMAAAQAQACxAwAAkQMAALIDAACSAwAAswMAAJMDAAC0AwAAlAMAALUDAACVAwAAtgMAAJYDAAC3AwAAlwMAALgDAACYAwAAuQMAAJkDAAC6AwAAmgMAALsDAACbAwAAvAMAAJwDAAC9AwAAnQMAAL4DAACeAwAAvwMAAJ8DAADAAwAAoAMAAMEDAAChAwAAwgMAAKMDAADDAwAAowMAAMQDAACkAwAAxQMAAKUDAADGAwAApgMAAMcDAACnAwAAyAMAAKgDAADJAwAAqQMAAMoDAACqAwAAywMAAKsDAADMAwAAjAMAAM0DAACOAwAAzgMAAI8DAADQAwAAkgMAANEDAACYAwAA1QMAAKYDAADWAwAAoAMAANcDAADPAwAA2QMAANgDAADbAwAA2gMAAN0DAADcAwAA3wMAAN4DAADhAwAA4AMAAOMDAADiAwAA5QMAAOQDAADnAwAA5gMAAOkDAADoAwAA6wMAAOoDAADtAwAA7AMAAO8DAADuAwAA8AMAAJoDAADxAwAAoQMAAPIDAAD5AwAA8wMAAH8DAAD1AwAAlQMAAPgDAAD3AwAA+wMAAPoDAAAwBAAAEAQAADEEAAARBAAAMgQAABIEAAAzBAAAEwQAADQEAAAUBAAANQQAABUEAAA2BAAAFgQAADcEAAAXBAAAOAQAABgE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QACMHwAAGwBAAI0fAAAcAEAAjh8AAB0AQACPHwAAHgBAAJAfAAAfAEAAkR8AACAAQACSHwAAIQBAAJMfAAAiAEAAlB8AACMAQACVHwAAJABAAJYfAAAlAEAAlx8AACYAQACYHwAAJwBAAJkfAAAoAEAAmh8AACkAQACbHwAAKgBAAJwfAAArAEAAnR8AACwAQACeHwAALQBAAJ8fAAAuAEAAoB8AAC8AQAChHwAAMABAAKIfAAAxAEAAox8AADIAQACkHwAAMwBAAKUfAAA0AEAAph8AADUAQACnHwAANgBAAKgfAAA3AEAAqR8AADgAQACqHwAAOQBAAKsfAAA6AEAArB8AADsAQACtHwAAPABAAK4fAAA9AEAArx8AAD4AQACwHwAAuB8AALEfAAC5HwAAsh8AAD8AQACzHwAAQABAALQfAABBAEAAth8AAEIAQAC3HwAAQwBAALwfAABEAEAAvh8AAJkDAADCHwAARQBAAMMfAABGAEAAxB8AAEcAQADGHwAASABAAMcfAABJAEAAzB8AAEoAQADQHwAA2B8AANEfAADZHwAA0h8AAEsAQADTHwAATABAANYfAABNAEAA1x8AAE4AQADgHwAA6B8AAOEfAADpHwAA4h8AAE8AQADjHwAAUABAAOQfAABRAEAA5R8AAOwfAADmHwAAUgBAAOcfAABTAEAA8h8AAFQAQADzHwAAVQBAAPQfAABWAEAA9h8AAFcAQAD3HwAAWABAAPwfAABZAEAATiEAADIhAABwIQAAYCEAAHEhAABhIQAAciEAAGIhAABzIQAAYyEAAHQhAABkIQAAdSEAAGUhAAB2IQAAZiEAAHchAABnIQAAeCEAAGghAAB5IQAAaSEAAHohAABqIQAAeyEAAGshAAB8IQAAbCEAAH0hAABtIQAAfiEAAG4hAAB/IQAAbyEAAIQhAACDIQAA0CQAALYkAADRJAAAtyQAANIkAAC4JAAA0yQAALkkAADUJAAAuiQAANUkAAC7JAAA1iQAALwkAADXJAAAvSQAANgkAAC+JAAA2SQAAL8kAADaJAAAwCQAANskAADBJAAA3CQAAMIkAADdJAAAwyQAAN4kAADEJAAA3yQAAMUkAADgJAAAxiQAAOEkAADHJAAA4iQAAMgkAADjJAAAySQAAOQkAADKJAAA5SQAAMskAADmJAAAzCQAAOckAADNJAAA6CQAAM4kAADpJAAAzyQAADAsAAAALAAAMSwAAAEsAAAyLAAAAiwAADMsAAADLAAANCwAAAQsAAA1LAAABSwAADYsAAAGLAAANywAAAcsAAA4LAAACCwAADksAAAJLAAAOiwAAAosAAA7LAAACywAADwsAAAMLAAAPSwAAA0sAAA+LAAADiwAAD8sAAAPLAAAQCwAABAsAABBLAAAESwAAEIsAAASLAAAQywAABMsAABELAAAFCwAAEUsAAAVLAAARiwAABYsAABHLAAAFywAAEgsAAAYLAAASSwAABksAABKLAAAGiwAAEssAAAbLAAATCwAABwsAABNLAAAHSwAAE4sAAAeLAAATywAAB8sAABQLAAAICwAAFEsAAAhLAAAUiwAACIsAABTLAAAIywAAFQsAAAkLAAAVSwAACUsAABWLAAAJiwAAFcsAAAnLAAAWCwAACgsAABZLAAAKSwAAFosAAAqLAAAWywAACssAABcLAAALCwAAF0sAAAtLAAAXiwAAC4sAABfLAAALywAAGEsAABgLAAAZSwAADoCAABmLAAAPgIAAGgsAABnLAAAaiwAAGksAABsLAAAaywAAHMsAAByLAAAdiwAAHUsAACBLAAAgCwAAIMsAACCLAAAhSwAAIQsAACHLAAAhiwAAIksAACILAAAiywAAIosAACNLAAAjCwAAI8sAACOLAAAkSwAAJAsAACTLAAAkiwAAJUsAACULAAAlywAAJYsAACZLAAAmCwAAJssAACaLAAAnSwAAJwsAACfLAAAniwAAKEsAACgLAAAoywAAKIsAAClLAAApCwAAKcsAACmLAAAqSwAAKgsAACrLAAAqiwAAK0sAACsLAAArywAAK4sAACxLAAAsCwAALMsAACyLAAAtSwAALQsAAC3LAAAtiwAALksAAC4LAAAuywAALosAAC9LAAAvCwAAL8sAAC+LAAAwSwAAMAsAADDLAAAwiwAAMUsAADELAAAxywAAMYsAADJLAAAyCwAAMssAADKLAAAzSwAAMwsAADPLAAAziwAANEsAADQLAAA0ywAANIsAADVLAAA1CwAANcsAADWLAAA2SwAANgsAADbLAAA2iwAAN0sAADcLAAA3ywAAN4sAADhLAAA4CwAAOMsAADiLAAA7CwAAOssAADuLAAA7SwAAPMsAADyLAAAAC0AAKAQAAABLQAAoRAAAAItAACiEAAAAy0AAKMQAAAELQAApBAAAAUtAAClEAAABi0AAKYQAAAHLQAApxAAAAgtAACoEAAACS0AAKkQAAAKLQAAqhAAAAstAACrEAAADC0AAKwQAAANLQAArRAAAA4tAACuEAAADy0AAK8QAAAQLQAAsBAAABEtAACxEAAAEi0AALIQAAATLQAAsxAAABQtAAC0EAAAFS0AALUQAAAWLQAAthAAABctAAC3EAAAGC0AALgQAAAZLQAAuRAAABotAAC6EAAAGy0AALsQAAAcLQAAvBAAAB0tAAC9EAAAHi0AAL4QAAAfLQAAvxAAACAtAADAEAAAIS0AAMEQAAAiLQAAwhAAACMtAADDEAAAJC0AAMQQAAAlLQAAxRAAACctAADHEAAALS0AAM0QAABBpgAAQKYAAEOmAABCpgAARaYAAESmAABHpgAARqYAAEmmAABIpgAAS6YAAEqmAABNpgAATKYAAE+mAABOpgAAUaYAAFCmAABTpgAAUqYAAFWmAABUpgAAV6YAAFamAABZpgAAWKYAAFumAABapgAAXaYAAFymAABfpgAAXqYAAGGmAABgpgAAY6YAAGKmAABlpgAAZKYAAGemAABmpgAAaaYAAGimAABrpgAAaqYAAG2mAABspgAAgaYAAICmAACDpgAAgqYAAIWmAACEpgAAh6YAAIamAACJpgAAiKYAAIumAACKpgAAjaYAAIymAACPpgAAjqYAAJGmAACQpgAAk6YAAJKmAACVpgAAlKYAAJemAACWpgAAmaYAAJimAACbpgAAmqYAACOnAAAipwAAJacAACSnAAAnpwAAJqcAACmnAAAopwAAK6cAACqnAAAtpwAALKcAAC+nAAAupwAAM6cAADKnAAA1pwAANKcAADenAAA2pwAAOacAADinAAA7pwAAOqcAAD2nAAA8pwAAP6cAAD6nAABBpwAAQKcAAEOnAABCpwAARacAAESnAABHpwAARqcAAEmnAABIpwAAS6cAAEqnAABNpwAATKcAAE+nAABOpwAAUacAAFCnAABTpwAAUqcAAFWnAABUpwAAV6cAAFanAABZpwAAWKcAAFunAABapwAAXacAAFynAABfpwAAXqcAAGGnAABgpwAAY6cAAGKnAABlpwAAZKcAAGenAABmpwAAaacAAGinAABrpwAAaqcAAG2nAABspwAAb6cAAG6nAAB6pwAAeacAAHynAAB7pwAAf6cAAH6nAACBpwAAgKcAAIOnAACCpwAAhacAAISnAACHpwAAhqcAAIynAACLpwAAkacAAJCnAACTpwAAkqcAAJSnAADEpwAAl6cAAJanAACZpwAAmKcAAJunAACapwAAnacAAJynAACfpwAAnqcAAKGnAACgpwAAo6cAAKKnAAClpwAApKcAAKenAACmpwAAqacAAKinAAC1pwAAtKcAALenAAC2pwAAuacAALinAAC7pwAAuqcAAL2nAAC8pwAAv6cAAL6nAADBpwAAwKcAAMOnAADCpwAAyKcAAMenAADKpwAAyacAAM2nAADMpwAAz6cAAM6nAADRpwAA0KcAANOnAADSpwAA1acAANSnAADXpwAA1qcAANmnAADYpwAA26cAANqnAAD2pwAA9acAAFOrAACzpwAAcKsAAKATAABxqwAAoRMAAHKrAACiEwAAc6sAAKMTAAB0qwAApBMAAHWrAAClEwAAdqsAAKYTAAB3qwAApxMAAHirAACoEwAAeasAAKkTAAB6qwAAqhMAAHurAACrEwAAfKsAAKwTAAB9qwAArRMAAH6rAACuEwAAf6sAAK8TAACAqwAAsBMAAIGrAACxEwAAgqsAALITAACDqwAAsxMAAISrAAC0EwAAhasAALUTAACGqwAAthMAAIerAAC3EwAAiKsAALgTAACJqwAAuRMAAIqrAAC6EwAAi6sAALsTAACMqwAAvBMAAI2rAAC9EwAAjqsAAL4TAACPqwAAvxMAAJCrAADAEwAAkasAAMETAACSqwAAwhMAAJOrAADDEwAAlKsAAMQTAACVqwAAxRMAAJarAADGEwAAl6sAAMcTAACYqwAAyBMAAJmrAADJEwAAmqsAAMoTAACbqwAAyxMAAJyrAADMEwAAnasAAM0TAACeqwAAzhMAAJ+rAADPEwAAoKsAANATAAChqwAA0RMAAKKrAADSEwAAo6sAANMTAACkqwAA1BMAAKWrAADVEwAApqsAANYTAACnqwAA1xMAAKirAADYEwAAqasAANkTAACqqwAA2hMAAKurAADbEwAArKsAANwTAACtqwAA3RMAAK6rAADeEwAAr6sAAN8TAACwqwAA4BMAALGrAADhEwAAsqsAAOITAACzqwAA4xMAALSrAADkEwAAtasAAOUTAAC2qwAA5hMAALerAADnEwAAuKsAAOgTAAC5qwAA6RMAALqrAADqEwAAu6sAAOsTAAC8qwAA7BMAAL2rAADtEwAAvqsAAO4TAAC/qwAA7xMAAAD7AABaAEAAAfsAAFsAQAAC+wAAXABAAAP7AABdAEAABPsAAF4AQAAF+wAAXwBAAAb7AABgAEAAE/sAAGEAQAAU+wAAYgBAABX7AABjAEAAFvsAAGQAQAAX+wAAZQBAAEH/AAAh/wAAQv8AACL/AABD/wAAI/8AAET/AAAk/wAARf8AACX/AABG/wAAJv8AAEf/AAAn/wAASP8AACj/AABJ/wAAKf8AAEr/AAAq/wAAS/8AACv/AABM/wAALP8AAE3/AAAt/wAATv8AAC7/AABP/wAAL/8AAFD/AAAw/wAAUf8AADH/AABS/wAAMv8AAFP/AAAz/wAAVP8AADT/AABV/wAANf8AAFb/AAA2/wAAV/8AADf/AABY/wAAOP8AAFn/AAA5/wAAWv8AADr/AAAoBAEAAAQBACkEAQABBAEAKgQBAAIEAQArBAEAAwQBACwEAQAEBAEALQQBAAUEAQAuBAEABgQBAC8EAQAHBAEAMAQBAAgEAQAxBAEACQQBADIEAQAKBAEAMwQBAAsEAQA0BAEADAQBADUEAQANBAEANgQBAA4EAQA3BAEADwQBADgEAQAQBAEAOQQBABEEAQA6BAEAEgQBADsEAQATBAEAPAQBABQEAQA9BAEAFQQBAD4EAQAWBAEAPwQBABcEAQBABAEAGAQBAEEEAQAZBAEAQgQBABoEAQBDBAEAGwQBAEQEAQAcBAEARQQBAB0EAQBGBAEAHgQBAEcEAQAfBAEASAQBACAEAQBJBAEAIQQBAEoEAQAiBAEASwQBACMEAQBMBAEAJAQBAE0EAQAlBAEATgQBACYEAQBPBAEAJwQBANgEAQCwBAEA2QQBALEEAQDaBAEAsgQBANsEAQCzBAEA3AQBALQEAQDdBAEAtQQBAN4EAQC2BAEA3wQBALcEAQDgBAEAuAQBAOEEAQC5BAEA4gQBALoEAQDjBAEAuwQBAOQEAQC8BAEA5QQBAL0EAQDmBAEAvgQBAOcEAQC/BAEA6AQBAMAEAQDpBAEAwQQBAOoEAQDCBAEA6wQBAMMEAQDsBAEAxAQBAO0EAQDFBAEA7gQBAMYEAQDvBAEAxwQBAPAEAQDIBAEA8QQBAMkEAQDyBAEAygQBAPMEAQDLBAEA9AQBAMwEAQD1BAEAzQQBAPYEAQDOBAEA9wQBAM8EAQD4BAEA0AQBAPkEAQDRBAEA+gQBANIEAQD7BAEA0wQBAJcFAQBwBQEAmAUBAHEFAQCZBQEAcgUBAJoFAQBzBQEAmwUBAHQFAQCcBQEAdQUBAJ0FAQB2BQEAngUBAHcFAQCfBQEAeAUBAKAFAQB5BQEAoQUBAHoFAQCjBQEAfAUBAKQFAQB9BQEApQUBAH4FAQCmBQEAfwUBAKcFAQCABQEAqAUBAIEFAQCpBQEAggUBAKoFAQCDBQEAqwUBAIQFAQCsBQEAhQUBAK0FAQCGBQEArgUBAIcFAQCvBQEAiAUBALAFAQCJBQEAsQUBAIoFAQCzBQEAjAUBALQFAQCNBQEAtQUBAI4FAQC2BQEAjwUBALcFAQCQBQEAuAUBAJEFAQC5BQEAkgUBALsFAQCUBQEAvAUBAJUFAQDADAEAgAwBAMEMAQCBDAEAwgwBAIIMAQDDDAEAgwwBAMQMAQCEDAEAxQwBAIUMAQDGDAEAhgwBAMcMAQCHDAEAyAwBAIgMAQDJDAEAiQwBAMoMAQCKDAEAywwBAIsMAQDMDAEAjAwBAM0MAQCNDAEAzgwBAI4MAQDPDAEAjwwBANAMAQCQDAEA0QwBAJEMAQDSDAEAkgwBANMMAQCTDAEA1AwBAJQMAQDVDAEAlQwBANYMAQCWDAEA1wwBAJcMAQDYDAEAmAwBANkMAQCZDAEA2gwBAJoMAQDbDAEAmwwBANwMAQCcDAEA3QwBAJ0MAQDeDAEAngwBAN8MAQCfDAEA4AwBAKAMAQDhDAEAoQwBAOIMAQCiDAEA4wwBAKMMAQDkDAEApAwBAOUMAQClDAEA5gwBAKYMAQDnDAEApwwBAOgMAQCoDAEA6QwBAKkMAQDqDAEAqgwBAOsMAQCrDAEA7AwBAKwMAQDtDAEArQwBAO4MAQCuDAEA7wwBAK8MAQDwDAEAsAwBAPEMAQCxDAEA8gwBALIMAQBwDQEAUA0BAHENAQBRDQEAcg0BAFINAQBzDQEAUw0BAHQNAQBUDQEAdQ0BAFUNAQB2DQEAVg0BAHcNAQBXDQEAeA0BAFgNAQB5DQEAWQ0BAHoNAQBaDQEAew0BAFsNAQB8DQEAXA0BAH0NAQBdDQEAfg0BAF4N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AACZAwAAAAAAAJEDAACZAwAAAAAAAIYDAACZAwAAAAAAAJEDAABCAwAAAAAAAJEDAABCAwAAmQMAAJEDAACZAwAAAAAAAMofAACZAwAAAAAAAJcDAACZAwAAAAAAAIkDAACZAwAAAAAAAJcDAABCAwAAAAAAAJcDAABCAwAAmQMAAJcDAACZAwAAAAAAAJkDAAAIAwAAAAMAAJkDAAAIAwAAAQMAAJkDAABCAwAAAAAAAJkDAAAIAwAAQgMAAKUDAAAIAwAAAAMAAKUDAAAIAwAAAQMAAKEDAAATAwAAAAAAAKUDAABCAwAAAAAAAKUDAAAIAwAAQgMAAPofAACZAwAAAAAAAKkDAACZAwAAAAAAAI8DAACZAwAAAAAAAKkDAABCAwAAAAAAAKkDAABCAwAAmQMAAKkDAACZAwAAAAAAAEYAAABGAAAAAAAAAEYAAABJAAAAAAAAAEYAAABMAAAAAAAAAEYAAABGAAAASQAAAEYAAABGAAAATAAAAFMAAABUAAAAAAAAAFMAAABUAAAAAAAAAEQFAABGBQAAAAAAAEQFAAA1BQAAAAAAAEQFAAA7BQAAAAAAAE4FAABGBQAAAAAAAEQFAAA9BQAAAAAAAHVzZXItcHJvdmlkZWQgY29tcGFyaXNvbiBmdW5jdGlvbiBkb2VzIG5vdCBjb3JyZWN0bHkgaW1wbGVtZW50IGEgdG90YWwgb3JkZXJSAhAALwAAAFwDAAAFAAAAZmFsc2V0cnVlUmVmQ2VsbCBhbHJlYWR5IGJvcnJvd2VkAAAAAwAAAAQAAAAEAAAABgAAAIP5ogBETm4A/CkVANFXJwDdNPUAYtvAADyZlQBBkEMAY1H+ALveqwC3YcUAOm4kANJNQgBJBuAACeouAByS0QDrHf4AKbEcAOg+pwD1NYIARLsuAJzphAC0JnAAQX5fANaROQBTgzkAnPQ5AItfhAAo+b0A+B87AN7/lwAPmAUAES/vAApaiwBtH20Az342AAnLJwBGT7cAnmY/AC3qXwC6J3UA5evHAD178QD3OQcAklKKAPtr6gAfsV8ACF2NADADVgB7/EYA8KtrACC8zwA29JoA46kdAF5hkQAIG+YAhZllAKAUXwCNQGgAgNj/ACdzTQAGBjEAylYVAMmocwB74mAAa4zAAAAAAED7Ifk/AAAAAC1EdD4AAACAmEb4PAAAAGBRzHg7AAAAgIMb8DkAAABAICV6OAAAAIAiguM2AAAAAB3zaTUAQcCVwQALAQQAhAEJcHJvZHVjZXJzAghsYW5ndWFnZQEEUnVzdAAMcHJvY2Vzc2VkLWJ5AwVydXN0YyUxLjk0LjAtbmlnaHRseSAoMzdhYTIxMzViIDIwMjUtMTItMDgpBndhbHJ1cwYwLjI0LjQMd2FzbS1iaW5kZ2VuEzAuMi4xMDYgKDExODMxZmI4OSkAaw90YXJnZXRfZmVhdHVyZXMGKw9tdXRhYmxlLWdsb2JhbHMrE25vbnRyYXBwaW5nLWZwdG9pbnQrC2J1bGstbWVtb3J5KwhzaWduLWV4dCsPcmVmZXJlbmNlLXR5cGVzKwptdWx0aXZhbHVl";
const wasmBytes = Uint8Array.from(Buffer.from(wasmBase64, "base64"));

const wasmModule = new WebAssembly.Module(wasmBytes);
const wasm = exports.__wasm = new WebAssembly.Instance(wasmModule, imports).exports;

wasm.__wbindgen_start();
