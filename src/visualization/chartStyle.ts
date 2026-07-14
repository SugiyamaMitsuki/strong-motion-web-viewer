export interface PublicationSeriesStyle {
  color: string;
  dashArray?: string;
}

// Okabe-Ito inspired colours, paired with independent dash patterns so that
// every series remains identifiable in greyscale and for colour-vision deficits.
export const PUBLICATION_SERIES_STYLES: readonly PublicationSeriesStyle[] = [
  { color: '#0072B2' },
  { color: '#D55E00', dashArray: '9 4' },
  { color: '#009E73', dashArray: '2 3' },
  { color: '#CC79A7', dashArray: '11 3 2 3' },
  { color: '#E69F00', dashArray: '6 3 1.5 3' },
  { color: '#56B4E9', dashArray: '12 4' },
  { color: '#3C3C3C', dashArray: '3 2' },
  { color: '#7B61A8', dashArray: '8 3 2 3 2 3' },
];

const COMPONENT_STYLES: Readonly<Record<string, PublicationSeriesStyle>> = {
  EW: { color: '#0072B2' },
  NS: { color: '#D55E00', dashArray: '9 4' },
  UD: { color: '#009E73', dashArray: '2 3' },
  OTHER: { color: '#CC79A7', dashArray: '11 3 2 3' },
};

export function publicationSeriesStyle(index: number): PublicationSeriesStyle {
  return PUBLICATION_SERIES_STYLES[index % PUBLICATION_SERIES_STYLES.length];
}

export function componentSeriesStyle(component: string, fallbackIndex = 0): PublicationSeriesStyle {
  return COMPONENT_STYLES[component] ?? publicationSeriesStyle(fallbackIndex);
}
