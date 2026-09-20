export type MedicineLookup = {
  name: string;
  activeIngredient: string;
  dosage: string;
  instructions: string;
  warnings: string;
  category: string;
  source: 'barcode-fda' | 'ocr-rxnorm';
  confidence: 'exact' | 'candidate';
};

type OpenFdaNdc = {
  brand_name?: string;
  generic_name?: string;
  dosage_form?: string;
  route?: string[];
  active_ingredients?: Array<{ name?: string; strength?: string }>;
  product_ndc?: string;
};

type OpenFdaLabel = {
  dosage_and_administration?: string[];
  warnings?: string[];
  warnings_and_cautions?: string[];
  indications_and_usage?: string[];
};

type RxNormCandidate = { rxcui?: string; name?: string; score?: string };

type RxTermsProperties = {
  displayName?: string;
  fullName?: string;
  fullGenericName?: string;
  strength?: string;
  rxtermsDoseForm?: string;
  route?: string;
};

const MAX_FIELD_LENGTH = 900;

function compactText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LENGTH);
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

function fdaLookupFromNdc(ndc: OpenFdaNdc, label?: OpenFdaLabel | null): MedicineLookup | null {
  const name = ndc.brand_name?.trim() || ndc.generic_name?.trim() || '';
  if (!name) return null;
  const activeIngredient = (ndc.active_ingredients ?? [])
    .map((ingredient) => [ingredient.name, ingredient.strength].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('; ');
  const dosage = [ndc.dosage_form, ...(ndc.route ?? [])].filter(Boolean).join(' · ');
  return {
    name,
    activeIngredient: activeIngredient || ndc.generic_name?.trim() || '',
    dosage,
    instructions: compactText(label?.dosage_and_administration),
    warnings: compactText(label?.warnings) || compactText(label?.warnings_and_cautions),
    category: 'Ліки',
    source: 'barcode-fda',
    confidence: 'exact',
  };
}

async function lookupLabelByName(name: string): Promise<OpenFdaLabel | null> {
  const cleanName = name.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanName) return null;
  for (const field of ['openfda.brand_name', 'openfda.generic_name']) {
    const data = await getJson<{ results?: OpenFdaLabel[] }>(
      `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(`${field}:"${cleanName}"`)}&limit=1`,
    );
    if (data?.results?.[0]) return data.results[0];
  }
  return null;
}

async function findRxNormCandidate(term: string): Promise<RxNormCandidate | null> {
  const data = await getJson<{ approximateGroup?: { candidate?: RxNormCandidate[] } }>(
    `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=1&option=1`,
  );
  return data?.approximateGroup?.candidate?.[0] ?? null;
}

async function lookupRxTerms(rxcui: string): Promise<RxTermsProperties | null> {
  const data = await getJson<{ rxtermsProperties?: RxTermsProperties }>(
    `https://rxnav.nlm.nih.gov/REST/RxTerms/rxcui/${encodeURIComponent(rxcui)}/allinfo.json`,
  );
  return data?.rxtermsProperties ?? null;
}

/**
 * Looks up a US NDC/UPC barcode in the public FDA directory. It is best-effort:
 * EAN codes from other markets may not exist in the FDA catalogue.
 */
export async function lookupMedicineByBarcode(barcode: string): Promise<MedicineLookup | null> {
  const normalized = barcode.replace(/\D/g, '');
  if (!normalized) return null;
  const candidates = Array.from(new Set([
    normalized,
    normalized.length === 13 && normalized.startsWith('0') ? normalized.slice(1) : '',
  ].filter(Boolean)));

  for (const code of candidates) {
    const searches = [`upc:${code}`, `product_ndc:${code}`];
    for (const search of searches) {
      const data = await getJson<{ results?: OpenFdaNdc[] }>(`https://api.fda.gov/drug/ndc.json?search=${encodeURIComponent(search)}&limit=1`);
      const ndc = data?.results?.[0];
      if (!ndc) continue;
      const productNdc = ndc.product_ndc?.trim();
      const label = productNdc
        ? await getJson<{ results?: OpenFdaLabel[] }>(`https://api.fda.gov/drug/label.json?search=${encodeURIComponent(`openfda.product_ndc:"${productNdc}"`)}&limit=1`)
        : null;
      const result = fdaLookupFromNdc(ndc, label?.results?.[0]);
      if (result) return result;
    }
  }
  return null;
}

/** Finds one high-ranking RxNorm candidate from package text. Any attached
 * instructions come from a separate public label lookup, never from OCR. */
export async function lookupMedicineByText(text: string): Promise<MedicineLookup | null> {
  const query = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (query.length < 3) return null;
  const candidate = await findRxNormCandidate(query);
  const rxTerms = candidate?.rxcui ? await lookupRxTerms(candidate.rxcui) : null;
  const name = rxTerms?.displayName?.trim() || candidate?.name?.trim() || '';
  if (!name) return null;
  const label = await lookupLabelByName(name);
  return {
    name,
    activeIngredient: rxTerms?.fullGenericName?.trim() || '',
    dosage: [rxTerms?.strength, rxTerms?.rxtermsDoseForm, rxTerms?.route].filter(Boolean).join(' · '),
    instructions: compactText(label?.dosage_and_administration),
    warnings: compactText(label?.warnings) || compactText(label?.warnings_and_cautions),
    category: 'Ліки',
    source: 'ocr-rxnorm',
    confidence: 'candidate',
  };
}

/** Name-first lookup: tries the structured FDA catalogue, then falls back to
 * RxNorm/RxTerms. The latter remains a candidate because names can be similar. */
export async function lookupMedicineByName(name: string): Promise<MedicineLookup | null> {
  const query = name.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (query.length < 3) return null;

  for (const field of ['brand_name', 'generic_name']) {
    const data = await getJson<{ results?: OpenFdaNdc[] }>(
      `https://api.fda.gov/drug/ndc.json?search=${encodeURIComponent(`${field}:"${query}"`)}&limit=1`,
    );
    const ndc = data?.results?.[0];
    if (!ndc) continue;
    const label = await lookupLabelByName(ndc.brand_name || ndc.generic_name || query);
    const result = fdaLookupFromNdc(ndc, label);
    if (result) return result;
  }

  return lookupMedicineByText(query);
}

/** Runs in the browser only. OCR stays on the device; the recognized text is
 * then optionally sent to RxNorm only to find a candidate medicine name. */
export async function recognizePackageText(file: File, onProgress?: (percent: number) => void): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  try {
    worker = await createWorker(['ukr', 'eng'], 1, {
      logger: (message) => onProgress?.(Math.round((message.progress || 0) * 100)),
    });
    const result = await worker.recognize(file);
    return result.data.text.replace(/\s+/g, ' ').trim();
  } catch {
    // English is a useful fallback for Latin medicine names and keeps the
    // feature usable if a browser cannot load the Ukrainian language pack.
    if (worker) await worker.terminate();
    worker = await createWorker('eng', 1, {
      logger: (message) => onProgress?.(Math.round((message.progress || 0) * 100)),
    });
    const result = await worker.recognize(file);
    return result.data.text.replace(/\s+/g, ' ').trim();
  } finally {
    if (worker) await worker.terminate();
  }
}
