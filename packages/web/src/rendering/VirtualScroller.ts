/**
 * VirtualScroller - Efficient Large Sequence Rendering
 *
 * Implements virtual scrolling for genome sequences that can be 100k+ bases.
 * Only renders visible rows plus overscan for smooth scrolling at 60fps.
 */

export interface VirtualScrollerOptions {
  /** Total number of items (characters in sequence) */
  totalItems: number;
  /** Width of each item in pixels */
  itemWidth: number;
  /** Height of each item in pixels */
  itemHeight: number;
  /** Viewport width in pixels */
  viewportWidth: number;
  /** Viewport height in pixels */
  viewportHeight: number;
  /** Number of rows to render outside viewport for smooth scrolling */
  overscan?: number;
  /** Enable smooth momentum scrolling */
  momentum?: boolean;
  /** Momentum friction coefficient (0-1, lower = more friction) */
  friction?: number;
  /** Minimum velocity before stopping momentum */
  minVelocity?: number;
  /** Rubber-band factor for overscroll (0-1, higher = stretchier) */
  rubberBand?: number;
  /** Maximum overscroll distance in pixels */
  maxOverscroll?: number;
  /** Snap scrolling to multiples of N items (e.g., 3 for codon alignment) */
  snapToMultiple?: number | null;
  /** Duration in ms for snap animation (simple linear) */
  snapAnimationMs?: number;
  /** Damping applied when bouncing off edges */
  bounceDamping?: number;
}

export interface VisibleRange {
  /** Start index in the sequence */
  startIndex: number;
  /** End index in the sequence (exclusive) */
  endIndex: number;
  /** Start row in the grid */
  startRow: number;
  /** End row in the grid (exclusive) */
  endRow: number;
  /** Y offset for first visible row (for smooth sub-row scrolling) */
  offsetY: number;
  /** X offset for first visible column (for smooth sub-column scrolling) */
  offsetX: number;
  /** Total visible items */
  visibleCount: number;
}

export interface ScrollState {
  /** Scroll position in pixels (X) */
  scrollX: number;
  /** Scroll position in pixels (Y) */
  scrollY: number;
  /** Velocity X (for momentum) */
  velocityX: number;
  /** Velocity Y (for momentum) */
  velocityY: number;
  /** Is currently animating momentum */
  isAnimating: boolean;
}

const DEFAULT_OPTIONS: Required<VirtualScrollerOptions> = {
  totalItems: 0,
  itemWidth: 16,
  itemHeight: 20,
  viewportWidth: 800,
  viewportHeight: 600,
  overscan: 3,
  momentum: true,
  friction: 0.95, // Higher = longer coast; closer to native feel
  minVelocity: 0.5,
  rubberBand: 0.5,
  maxOverscroll: 50,
  snapToMultiple: null,
  snapAnimationMs: 150,
  bounceDamping: 0.3,
};

export class VirtualScroller {
  private options: Required<VirtualScrollerOptions>;
  private state: ScrollState;
  private animationFrameId: number | null = null;
  private onScrollCallback: ((range: VisibleRange) => void) | null = null;

  // Layout calculations
  private cols: number = 0;
  private rows: number = 0;
  private totalHeight: number = 0;
  private totalWidth: number = 0;

  constructor(options: VirtualScrollerOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.state = {
      scrollX: 0,
      scrollY: 0,
      velocityX: 0,
      velocityY: 0,
      isAnimating: false,
    };
    this.recalculateLayout();
  }

  /**
   * Recalculate layout when options change
   */
  private recalculateLayout(): void {
    const { totalItems, itemWidth, itemHeight, viewportWidth } = this.options;

    // Calculate how many columns fit in the viewport
    this.cols = Math.max(1, Math.floor(viewportWidth / itemWidth));

    // Calculate total rows needed
    this.rows = Math.ceil(totalItems / this.cols);

    // Calculate total scrollable dimensions
    this.totalHeight = this.rows * itemHeight;
    this.totalWidth = this.cols * itemWidth;
  }

  /**
   * Update options and recalculate layout
   */
  updateOptions(options: Partial<VirtualScrollerOptions>): void {
    this.options = { ...this.options, ...options };
    this.recalculateLayout();

    // Clamp scroll position to valid range
    this.state.scrollY = Math.max(
      0,
      Math.min(this.state.scrollY, this.maxScrollY)
    );
    this.state.scrollX = Math.max(
      0,
      Math.min(this.state.scrollX, this.maxScrollX)
    );
  }

  /**
   * Get the currently visible range
   */
  getVisibleRange(): VisibleRange {
    const { itemHeight, itemWidth, viewportWidth, viewportHeight, overscan } = this.options;
    const { scrollX, scrollY } = this.state;

    // Calculate visible row range
    const startRow = Math.max(0, Math.floor(scrollY / itemHeight) - overscan);
    const visibleRows = Math.ceil(viewportHeight / itemHeight) + overscan * 2;
    const endRow = Math.min(this.rows, startRow + visibleRows);

    // Calculate visible column range (for horizontal scrolling if needed)
    const startCol = Math.max(0, Math.floor(scrollX / itemWidth));
    const visibleCols = Math.ceil(viewportWidth / itemWidth);
    const endCol = Math.min(this.cols, startCol + visibleCols);

    // Calculate indices
    const startIndex = startRow * this.cols + startCol;
    const endIndex = Math.min(
      this.options.totalItems,
      (endRow - 1) * this.cols + endCol
    );

    // Calculate pixel offsets for sub-cell scrolling
    const offsetY = -(scrollY % itemHeight);
    const offsetX = -(scrollX % itemWidth);

    return {
      startIndex,
      endIndex,
      startRow,
      endRow,
      offsetY,
      offsetX,
      visibleCount: endIndex - startIndex,
    };
  }

  /**
   * Get maximum scroll Y position
   */
  get maxScrollY(): number {
    return Math.max(0, this.totalHeight - this.options.viewportHeight);
  }

  /**
   * Get maximum scroll X position
   */
  get maxScrollX(): number {
    return Math.max(0, this.totalWidth - this.options.viewportWidth);
  }

  /**
   * Scroll by delta
   */
  scrollBy(deltaX: number, deltaY: number): void {
    this.scrollTo(
      this.state.scrollX + deltaX,
      this.state.scrollY + deltaY
    );
  }

  /**
   * Scroll to absolute position
   */
  scrollTo(x: number, y: number): void {
    const newScrollX = this.applyRubberBand(x, this.maxScrollX);
    const newScrollY = this.applyRubberBand(y, this.maxScrollY);

    if (newScrollX !== this.state.scrollX || newScrollY !== this.state.scrollY) {
      this.state.scrollX = newScrollX;
      this.state.scrollY = newScrollY;
      this.notifyScrollChange();
    }
  }

  /**
   * Scroll to index (centers the index in viewport if possible)
   */
  scrollToIndex(index: number, center = true): void {
    const row = Math.floor(index / this.cols);
    const targetY = row * this.options.itemHeight;

    if (center) {
      const centerOffset = (this.options.viewportHeight - this.options.itemHeight) / 2;
      this.scrollTo(this.state.scrollX, targetY - centerOffset);
    } else {
      this.scrollTo(this.state.scrollX, targetY);
    }
  }

  /**
   * Scroll to start
   */
  scrollToStart(): void {
    this.scrollTo(0, 0);
  }

  /**
   * Scroll to end
   */
  scrollToEnd(): void {
    this.scrollTo(this.maxScrollX, this.maxScrollY);
  }

  // Touch tracking state
  private touchStartX = 0;
  private touchStartY = 0;
  private touchStartScrollX = 0;
  private touchStartScrollY = 0;
  private lastTouchX = 0;
  private lastTouchY = 0;
  private lastTouchTime = 0;

  /**
   * Handle wheel event
   */
  handleWheel(event: WheelEvent): void {
    event.preventDefault();

    // Calculate scroll delta
    let deltaX = event.deltaX;
    let deltaY = event.deltaY;

    // Normalize for different wheel modes
    if (event.deltaMode === 1) {
      // Line mode
      deltaX *= this.options.itemWidth;
      deltaY *= this.options.itemHeight;
    } else if (event.deltaMode === 2) {
      // Page mode
      deltaX *= this.options.viewportWidth;
      deltaY *= this.options.viewportHeight;
    }

    if (this.options.momentum) {
      // Add velocity for momentum scrolling
      this.state.velocityX = deltaX * 0.3;
      this.state.velocityY = deltaY * 0.3;
      this.startMomentum();
    } else {
      // Direct scrolling
      this.scrollBy(deltaX, deltaY);
    }
  }

  /**
   * Handle touch start
   */
  handleTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
    this.touchStartScrollX = this.state.scrollX;
    this.touchStartScrollY = this.state.scrollY;
    this.lastTouchX = touch.clientX;
    this.lastTouchY = touch.clientY;
    this.lastTouchTime = performance.now();

    // Stop any ongoing momentum
    this.stopMomentum();
  }

  /**
   * Handle touch move
   */
  handleTouchMove(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    event.preventDefault(); // Prevent native scroll

    const touch = event.touches[0];
    const now = performance.now();
    const dt = Math.max(1, now - this.lastTouchTime);

    // Calculate instantaneous velocity (scale to ~60fps frame time)
    const instantVx = (this.lastTouchX - touch.clientX) / dt * 16.67;
    const instantVy = (this.lastTouchY - touch.clientY) / dt * 16.67;

    // Smooth velocity with exponential moving average for better feel
    const smoothing = 0.4;
    const vx = this.state.velocityX * (1 - smoothing) + instantVx * smoothing;
    const vy = this.state.velocityY * (1 - smoothing) + instantVy * smoothing;

    // Apply scroll (inverted - drag down = scroll up)
    const deltaX = this.touchStartX - touch.clientX;
    const deltaY = this.touchStartY - touch.clientY;
    this.scrollTo(
      this.touchStartScrollX + deltaX,
      this.touchStartScrollY + deltaY
    );

    // Update tracking
    this.state.velocityX = vx;
    this.state.velocityY = vy;
    this.lastTouchX = touch.clientX;
    this.lastTouchY = touch.clientY;
    this.lastTouchTime = now;
  }

  /**
   * Handle touch end
   */
  handleTouchEnd(): void {
    // Start momentum if velocity is significant
    const speed = Math.abs(this.state.velocityX) + Math.abs(this.state.velocityY);
    if (this.options.momentum && speed > 2) {
      this.startMomentum();
    } else if (this.options.snapToMultiple) {
      this.snapToMultipleBoundary(this.options.snapToMultiple);
    }
  }

  /**
   * Start momentum animation
   */
  private startMomentum(): void {
    if (this.state.isAnimating) return;

    this.state.isAnimating = true;
    this.animateMomentum();
  }

  /**
   * Animate momentum scrolling
   */
  private animateMomentum = (): void => {
    if (!this.state.isAnimating) return;

    const { friction, minVelocity, snapToMultiple, bounceDamping } = this.options;

    // Apply velocity
    this.scrollBy(this.state.velocityX, this.state.velocityY);

    // Apply friction
    this.state.velocityX *= friction;
    this.state.velocityY *= friction;

    // Edge bounce with damping
    if (this.state.scrollY < 0) {
      this.state.scrollY *= this.options.rubberBand;
      this.state.velocityY *= -bounceDamping;
    } else if (this.state.scrollY > this.maxScrollY) {
      const over = this.state.scrollY - this.maxScrollY;
      this.state.scrollY = this.maxScrollY + over * this.options.rubberBand;
      this.state.velocityY *= -bounceDamping;
    }

    // Stop if velocity is negligible
    const speed = Math.abs(this.state.velocityX) + Math.abs(this.state.velocityY);
    if (speed < (minVelocity ?? 0.1)) {
      this.state.isAnimating = false;
      this.state.velocityX = 0;
      this.state.velocityY = 0;
      if (snapToMultiple) {
        this.snapToMultipleBoundary(snapToMultiple);
      }
      return;
    }

    // Continue animation
    this.animationFrameId = requestAnimationFrame(this.animateMomentum);
  };

  /**
   * Stop momentum animation
   */
  stopMomentum(): void {
    this.state.isAnimating = false;
    this.state.velocityX = 0;
    this.state.velocityY = 0;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Update snapping preference
   */
  setSnapToMultiple(multiple: number | null): void {
    this.updateOptions({ snapToMultiple: multiple });
  }

  /**
   * Snap to nearest multiple boundary (vertical scroll only)
   */
  private snapToMultipleBoundary(multiple: number): void {
    if (multiple <= 0) return;
    const target = Math.round(this.state.scrollY / (this.options.itemHeight * multiple)) * (this.options.itemHeight * multiple);
    const clamped = Math.max(0, Math.min(target, this.maxScrollY));
    this.scrollTo(this.state.scrollX, clamped);
  }

  /**
   * Apply rubber banding to a scroll value
   */
  private applyRubberBand(value: number, max: number): number {
    const { rubberBand, maxOverscroll } = this.options;
    if (value < 0) {
      const overshoot = Math.max(value, -maxOverscroll);
      return overshoot * rubberBand;
    }
    if (value > max) {
      const overshoot = Math.min(value - max, maxOverscroll);
      return max + overshoot * rubberBand;
    }
    return value;
  }

  /**
   * Set scroll change callback
   */
  onScroll(callback: (range: VisibleRange) => void): void {
    this.onScrollCallback = callback;
  }

  /**
   * Notify scroll change
   */
  private notifyScrollChange(): void {
    if (this.onScrollCallback) {
      this.onScrollCallback(this.getVisibleRange());
    }
  }

  /**
   * Get current scroll state
   */
  getScrollState(): ScrollState {
    return { ...this.state };
  }

  /**
   * Get layout info
   */
  getLayout(): {
    cols: number;
    rows: number;
    totalHeight: number;
    totalWidth: number;
  } {
    return {
      cols: this.cols,
      rows: this.rows,
      totalHeight: this.totalHeight,
      totalWidth: this.totalWidth,
    };
  }

  /**
   * Get index at viewport coordinates
   */
  getIndexAtPoint(x: number, y: number): number | null {
    const { scrollX, scrollY } = this.state;
    const { itemWidth, itemHeight } = this.options;

    const absoluteX = scrollX + x;
    const absoluteY = scrollY + y;

    const col = Math.floor(absoluteX / itemWidth);
    const row = Math.floor(absoluteY / itemHeight);

    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      return null;
    }

    const index = row * this.cols + col;
    if (index >= this.options.totalItems) {
      return null;
    }

    return index;
  }

  /**
   * Get viewport coordinates for an index
   */
  getPointForIndex(index: number): { x: number; y: number } | null {
    if (index < 0 || index >= this.options.totalItems) {
      return null;
    }

    const col = index % this.cols;
    const row = Math.floor(index / this.cols);

    const { itemWidth, itemHeight } = this.options;
    const { scrollX, scrollY } = this.state;

    return {
      x: col * itemWidth - scrollX,
      y: row * itemHeight - scrollY,
    };
  }

  /**
   * Prefetch ahead of scroll direction
   */
  prefetchAhead(direction: 'up' | 'down' | 'left' | 'right', distance: number): VisibleRange {
    const currentRange = this.getVisibleRange();

    let prefetchStartRow = currentRange.startRow;
    let prefetchEndRow = currentRange.endRow;

    if (direction === 'up') {
      prefetchStartRow = Math.max(0, prefetchStartRow - distance);
    } else if (direction === 'down') {
      prefetchEndRow = Math.min(this.rows, prefetchEndRow + distance);
    }

    // Return the prefetch range
    return {
      ...currentRange,
      startRow: prefetchStartRow,
      endRow: prefetchEndRow,
      startIndex: prefetchStartRow * this.cols,
      endIndex: Math.min(this.options.totalItems, prefetchEndRow * this.cols),
    };
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.stopMomentum();
    this.onScrollCallback = null;
  }
}

export default VirtualScroller;
