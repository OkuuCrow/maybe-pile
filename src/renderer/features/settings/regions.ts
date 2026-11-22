/** ISO 3166-1 alpha-2 regions offered for watch availability (subset with streaming data). */
export const REGIONS: readonly (readonly [string, string])[] = [
  ['AR', 'Argentina'],
  ['AU', 'Australia'],
  ['AT', 'Austria'],
  ['BE', 'Belgium'],
  ['BR', 'Brazil'],
  ['CA', 'Canada'],
  ['CL', 'Chile'],
  ['CO', 'Colombia'],
  ['CZ', 'Czechia'],
  ['DK', 'Denmark'],
  ['FI', 'Finland'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['GR', 'Greece'],
  ['HK', 'Hong Kong'],
  ['HU', 'Hungary'],
  ['IN', 'India'],
  ['ID', 'Indonesia'],
  ['IE', 'Ireland'],
  ['IL', 'Israel'],
  ['IT', 'Italy'],
  ['JP', 'Japan'],
  ['KR', 'South Korea'],
  ['MY', 'Malaysia'],
  ['MX', 'Mexico'],
  ['NL', 'Netherlands'],
  ['NZ', 'New Zealand'],
  ['NO', 'Norway'],
  ['PH', 'Philippines'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['RO', 'Romania'],
  ['SG', 'Singapore'],
  ['ZA', 'South Africa'],
  ['ES', 'Spain'],
  ['SE', 'Sweden'],
  ['CH', 'Switzerland'],
  ['TW', 'Taiwan'],
  ['TH', 'Thailand'],
  ['TR', 'Türkiye'],
  ['UA', 'Ukraine'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
];

/** Default region from the OS locale (e.g. "en-GB" → "GB"), falling back to US. */
export function regionFromLocale(locale: string | undefined): string {
  const m = /[-_]([A-Za-z]{2})\b/.exec(locale ?? '');
  const code = m?.[1]?.toUpperCase();
  return code && REGIONS.some(([c]) => c === code) ? code : 'US';
}
