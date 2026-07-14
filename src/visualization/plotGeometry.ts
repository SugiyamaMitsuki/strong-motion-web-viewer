export interface PlotPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PlotGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computePlotGeometry(
  width: number,
  height: number,
  padding: PlotPadding,
  equalAspect: boolean,
): PlotGeometry {
  const availableWidth = Math.max(40, width - padding.left - padding.right);
  const availableHeight = Math.max(40, height - padding.top - padding.bottom);
  const squareSize = Math.min(availableWidth, availableHeight);
  const plotWidth = equalAspect ? squareSize : availableWidth;
  const plotHeight = equalAspect ? squareSize : availableHeight;
  return {
    left: padding.left + (availableWidth - plotWidth) / 2,
    top: padding.top + (availableHeight - plotHeight) / 2,
    width: plotWidth,
    height: plotHeight,
  };
}
