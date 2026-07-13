# Numerical validation

The browser implementation now includes dependency-free regression tests for the numerical kernels that most directly affect engineering results.

Run the checks with:

```bash
npm test
```

The test suite verifies:

- complex FFT forward/inverse round-trip accuracy;
- JMA filtering with the gain applied to both real and imaginary parts of the complete conjugate spectrum;
- selection of the K-th largest vector acceleration sample covering at least 0.3 seconds, including non-divisor sampling intervals;
- rejection of cross-station, ambiguous, or start-time-mismatched JMA component sets;
- use of only the common valid sample span when JMA components have different sampling intervals;
- independent evaluation of each 60-second interval in JMA download files;
- rejection of truncated JMA intervals, missing component cells, and unknown units;
- particle-orbit resampling and physical start-time alignment on a shared overlap grid;
- separation of particle-orbit records belonging to different events;
- the response-spectrum identity `pSv = omega * Sd`;
- response-spectrum peaks between coarse input samples against an analytic undamped solution;
- high-damping inter-sample peaks against a refined piecewise-linear reference;
- bounded handling of unsupported or non-finite response periods;
- equivalence between implicit post-record free vibration and explicit zero padding;
- zero response for zero acceleration input.

`npm run check` runs the TypeScript check, numerical tests, and production build.

## Reference definitions

- Japan Meteorological Agency, "Calculation of instrumental seismic intensity":
  https://www.jma.go.jp/jma/kishou/know/jishin/kyoshin/kaisetsu/calc_sindo.html
- U.S. Army Corps of Engineers, EM 1110-2-6050, Appendix B: `V = omega D` for pseudo-relative velocity.
