'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CJ_AFFILIATE_PREFIX = 'https://www.dpbolvw.net/click-101752886-12607708?url=';
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'safety-thresholds.json');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const REVIEW_OUTPUT_ROOT = path.join(PROJECT_ROOT, 'review-artifacts');
const TRACKED_SNAPSHOT_NAMES = new Set(['products.json', 'superzoo-partner-foods.json']);
const PROTECTED_FIXTURE_PATHS = new Set([
  path.resolve(__dirname, '..', 'test', 'fixtures', 'baselines', 'superzoo-legacy-1405.json').toLowerCase(),
  path.resolve(__dirname, '..', 'test', 'fixtures', 'avicentra-manual-review-later.json').toLowerCase(),
]);
const MAX_PERCENT_DECODE_ROUNDS = 8;
const MAX_NESTED_QUERY_VALUE_LENGTH = 64 * 1024;
const SENSITIVE_DIAGNOSTIC_NAMES = new Set([
  'authorization', 'apikey', 'accesstoken', 'auth', 'password', 'passwd', 'secret', 'token',
  'clientsecret', 'privatekey', 'sessionid',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathsEqual(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolveThroughExistingAncestor(filePath) {
  const absolutePath = path.resolve(filePath);
  let ancestor = absolutePath;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve output path ancestor: ${filePath}`);
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync.native ? fs.realpathSync.native(ancestor) : fs.realpathSync(ancestor);
  return path.resolve(realAncestor, path.relative(ancestor, absolutePath));
}

function lstatIfPresent(filePath) {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Cannot safely inspect output path: ${filePath}`);
  }
}

function approvedOutputRoots() {
  const realProjectRoot = fs.realpathSync.native ? fs.realpathSync.native(PROJECT_ROOT) : fs.realpathSync(PROJECT_ROOT);
  const roots = [{ lexical: REVIEW_OUTPUT_ROOT, physical: path.join(realProjectRoot, 'review-artifacts'), kind: 'review-artifacts' }];
  const addTemporaryRoot = (candidate, kind) => {
    if (typeof candidate !== 'string' || !candidate.trim() || !path.isAbsolute(candidate)) return;
    const lexical = path.resolve(candidate);
    const metadata = lstatIfPresent(lexical);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return;
    const physical = fs.realpathSync.native ? fs.realpathSync.native(lexical) : fs.realpathSync(lexical);
    if (isPathInside(realProjectRoot, physical)) return;
    roots.push({ lexical, physical, kind });
  };
  addTemporaryRoot(os.tmpdir(), 'os.tmpdir');
  if (process.env.RUNNER_TEMP) addTemporaryRoot(process.env.RUNNER_TEMP, 'RUNNER_TEMP');
  return roots;
}

function validateSafeOutputPath(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Output path must be a non-empty string.');
  const resolved = path.resolve(filePath);
  const basename = path.basename(resolved).replace(/[. ]+$/g, '').toLowerCase();
  if (TRACKED_SNAPSHOT_NAMES.has(basename)) {
    throw new Error(`Refusing to overwrite tracked snapshot path: ${filePath}`);
  }
  if (PROTECTED_FIXTURE_PATHS.has(resolved.toLowerCase())) {
    throw new Error(`Refusing to overwrite immutable audit/test fixture: ${filePath}`);
  }
  const roots = approvedOutputRoots();
  const root = roots.find(candidate => !pathsEqual(candidate.lexical, resolved) && isPathInside(candidate.lexical, resolved));
  if (!root) throw new Error(`Refusing output path outside approved review/temp roots: ${filePath}`);
  const rootMetadata = lstatIfPresent(root.lexical);
  if (rootMetadata?.isSymbolicLink()) throw new Error(`Refusing an approved output root replaced by a symlink or junction: ${filePath}`);
  if (rootMetadata) {
    const realRoot = fs.realpathSync.native ? fs.realpathSync.native(root.lexical) : fs.realpathSync(root.lexical);
    if (!pathsEqual(realRoot, root.physical)) throw new Error(`Refusing an ambiguous approved output root: ${filePath}`);
  }

  const relative = path.relative(root.lexical, resolved);
  let lexicalCursor = root.lexical;
  let physicalCursor = root.physical;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    lexicalCursor = path.join(lexicalCursor, segment);
    physicalCursor = path.join(physicalCursor, segment);
    const metadata = lstatIfPresent(lexicalCursor);
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) throw new Error(`Refusing output path containing a symlink or junction: ${filePath}`);
    const realComponent = fs.realpathSync.native ? fs.realpathSync.native(lexicalCursor) : fs.realpathSync(lexicalCursor);
    if (!pathsEqual(realComponent, physicalCursor) || !isPathInside(root.physical, realComponent)) {
      throw new Error(`Refusing output path with an ambiguous or escaping filesystem component: ${filePath}`);
    }
  }
  const realResolved = resolveThroughExistingAncestor(resolved);
  if (!isPathInside(root.physical, realResolved)) throw new Error(`Refusing output path that escapes its approved root: ${filePath}`);
  const finalMetadata = lstatIfPresent(resolved);
  if (finalMetadata && !options.allowExistingFinal) throw new Error(`Refusing to overwrite an existing final output: ${filePath}`);
  if (finalMetadata && options.requireRegularFile && (!finalMetadata.isFile() || finalMetadata.isSymbolicLink())) {
    throw new Error(`Refusing a non-regular output file: ${filePath}`);
  }
  return resolved;
}

function assertSafeOutputPath(filePath) { return validateSafeOutputPath(filePath); }

function redactDiagnosticValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (typeof value === 'bigint') return `[BigInt ${value.toString()}]`;
  if (typeof value === 'symbol') return redactDiagnosticText(String(value));
  if (value == null || !['object', 'function'].includes(typeof value)) return value;
  if (depth >= 16) return '[Diagnostic depth limit]';
  let isError = false;
  try { isError = value instanceof Error; } catch { return '[Unprintable diagnostic value]'; }
  if (isError) return serializeDiagnosticError(value, 0, seen);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < Math.min(value.length, 1000); index += 1) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch { return '[Unprintable diagnostic value]'; }
      result.push(descriptor?.get || descriptor?.set ? '[Accessor]' : redactDiagnosticValue(descriptor?.value, seen, depth + 1));
    }
    if (value.length > 1000) result.push('[Diagnostic item limit]');
    return result;
  }
  const result = {};
  let keys;
  try { keys = Reflect.ownKeys(value).slice(0, 1000); } catch { return '[Unprintable diagnostic value]'; }
  for (const rawKey of keys) {
    const key = redactDiagnosticText(typeof rawKey === 'symbol' ? String(rawKey) : rawKey);
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, rawKey); } catch { result[key] = '[Unprintable diagnostic value]'; continue; }
    if (!descriptor || descriptor.get || descriptor.set) { result[key] = '[Accessor]'; continue; }
    result[key] = isSensitivePropertyName(rawKey) ? '[REDACTED]' : redactDiagnosticValue(descriptor.value, seen, depth + 1);
  }
  return result;
}

function writeJson(filePath, value) {
  writeFileAtomicNoReplace(filePath, `${JSON.stringify(redactDiagnosticValue(value), null, 2)}\n`);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomicNoReplace(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safelyRemoveOwnedTemporary(temporaryPath, identity) {
  try {
    const current = fs.lstatSync(temporaryPath);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(temporaryPath);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function writeFileAtomicNoReplace(filePath, contents) {
  const absolutePath = assertSafeOutputPath(filePath);
  const directory = path.dirname(absolutePath);
  fs.mkdirSync(directory, { recursive: true });
  assertSafeOutputPath(absolutePath);
  let temporaryPath;
  let identity;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    temporaryPath = `${absolutePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      validateSafeOutputPath(temporaryPath);
      const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
        fs.fsyncSync(descriptor);
        identity = fs.fstatSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === 9) throw error;
    }
  }
  try {
    validateSafeOutputPath(temporaryPath, { allowExistingFinal: true, requireRegularFile: true });
    assertSafeOutputPath(absolutePath);
    fs.linkSync(temporaryPath, absolutePath);
  } finally {
    if (temporaryPath && identity) safelyRemoveOwnedTemporary(temporaryPath, identity);
  }
}

function writeTextAtomic(filePath, value) { writeFileAtomicNoReplace(filePath, redactDiagnosticText(value)); }

function parseCliArgs(argv) {
  const result = {};
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const separator = argument.indexOf('=');
    if (separator === -1) result[argument.slice(2)] = true;
    else result[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return result;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(value, maximumLength = 64) {
  return normalizeText(value).replace(/\s+/g, '-').slice(0, maximumLength).replace(/-+$/g, '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseSuperZooUrl(rawUrl, allowedHosts) {
  const source = String(rawUrl || '').trim();
  const rawParts = source.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)([^#]*)/u);
  if (rawParts && /%(?![0-9a-f]{2})/iu.test(rawParts[2])) throw new Error('Malformed percent encoding in product URL path or query.');
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error('Invalid product URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported product URL protocol: ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new Error('Product URL must not contain credentials.');
  const rawHostPort = rawParts?.[1]?.slice((rawParts[1].lastIndexOf('@') + 1));
  if (rawHostPort?.includes(':')) throw new Error('Product URL must not contain an explicit port.');
  if (parsed.port) throw new Error(`Unexpected product URL port: ${parsed.port}`);
  const hostname = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(hostname)) throw new Error(`Unexpected product URL host: ${hostname}`);
  if (normalizeIdentityPath(parsed.pathname) === '/') throw new Error('Product URL must contain a non-root product path.');
  return { parsed, source };
}

function normalizeIdentityPath(pathname) {
  if (/%(?![0-9a-f]{2})/iu.test(pathname)) throw new Error('Malformed percent encoding in product URL path.');
  const normalizedEscapes = pathname.replace(/%([0-9a-f]{2})/giu, (match, hex) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9._~-]/u.test(character) ? character : `%${hex.toUpperCase()}`;
  });
  return normalizedEscapes.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function canonicalizeProductUrl(rawUrl, configOrHosts = ['superzoo.cz', 'www.superzoo.cz']) {
  const config = Array.isArray(configOrHosts) ? null : configOrHosts;
  const allowedHosts = config ? config.sourcePolicy.allowedHosts : configOrHosts;
  const allowlist = new Set(config?.sourcePolicy?.identityQueryParameterAllowlist || []);
  const canonicalHost = config?.sourcePolicy?.canonicalIdentityHost || 'www.superzoo.cz';
  if (!allowedHosts.includes(canonicalHost)) throw new Error(`Canonical identity host is not allowed: ${canonicalHost}`);
  const { parsed } = parseSuperZooUrl(rawUrl, allowedHosts);
  parsed.protocol = 'https:';
  parsed.hostname = canonicalHost;
  parsed.hash = '';
  parsed.pathname = normalizeIdentityPath(parsed.pathname);
  for (const key of [...parsed.searchParams.keys()]) {
    if (!allowlist.has(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

function preserveAffiliateTargetUrl(rawUrl, config) {
  const { parsed, source } = parseSuperZooUrl(rawUrl, config.sourcePolicy.allowedHosts);
  assertNoNestedRedirectParameters(parsed);
  return source;
}

const REDIRECT_PARAMETER_NAMES = new Set([
  'url', 'uri', 'redirect', 'redirecturl', 'redirecturi', 'destination', 'destinationurl', 'destinationuri',
  'dest', 'target', 'targeturl', 'targeturi', 'return', 'returnurl', 'returnuri', 'returnto',
  'next', 'nexturl', 'nexturi', 'continue', 'continueurl', 'continueuri', 'callback', 'callbackurl',
  'goto', 'forward',
]);

function decodePercentLayersStrict(value, context) {
  let decoded = String(value);
  if (decoded.length > MAX_NESTED_QUERY_VALUE_LENGTH) throw new Error(`${context} exceeds the safety length limit.`);
  for (let depth = 0; depth < MAX_PERCENT_DECODE_ROUNDS; depth += 1) {
    if (!decoded.includes('%')) return decoded;
    if (/%(?![0-9a-f]{2})/iu.test(decoded)) throw new Error(`Malformed percent encoding in ${context}.`);
    let next;
    try { next = decodeURIComponent(decoded); } catch { throw new Error(`Invalid percent-encoded UTF-8 in ${context}.`); }
    if (next === decoded) return decoded;
    decoded = next;
  }
  if (/%[0-9a-f]{2}/iu.test(decoded)) throw new Error(`Over-encoded or unstable ${context}.`);
  return decoded;
}

function normalizeParameterName(value) { return String(value).toLowerCase().replace(/[^a-z0-9]/gu, ''); }

function assertNoRedirectSyntaxInValue(rawValue) {
  const decoded = decodePercentLayersStrict(rawValue, 'product URL query value');
  const parameterPattern = /(?:^|[?&#;])\s*([^?&#;=]{1,128})\s*=/gu;
  let match;
  while ((match = parameterPattern.exec(decoded)) !== null) {
    const name = normalizeParameterName(match[1]);
    if (REDIRECT_PARAMETER_NAMES.has(name)) throw new Error('Product URL must not contain a nested destination parameter.');
  }
}

function assertNoNestedRedirectParameters(parsed) {
  for (const [rawName, rawValue] of parsed.searchParams.entries()) {
    const normalizedName = normalizeParameterName(decodePercentLayersStrict(rawName, 'product URL query parameter name'));
    if (REDIRECT_PARAMETER_NAMES.has(normalizedName)) throw new Error('Product URL must not contain a nested destination parameter.');
    assertNoRedirectSyntaxInValue(rawValue);
  }
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
  if (!value || /^\s*[-\u2212]/u.test(String(value))) return null;
  const filtered = String(value)
    .split(/\r?\n/)
    .filter(line => !/(?:za|\/\s*)\s*(?:100\s*g|1\s*kg)/i.test(line))
    .join(' ');
  const matches = filtered.match(/\d[\d\s]*(?:[,.]\d{1,2})?/g) || [];
  for (const match of matches) {
    const parsed = Number.parseFloat(match.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) return Number(parsed.toFixed(2));
  }
  return null;
}

function resolvePrices(product) {
  const current = parseMoney(product.salePrice) ?? parseMoney(product.price);
  const originalCandidate = parseMoney(product.originalPrice);
  return {
    price: current,
    salePrice: originalCandidate && current && originalCandidate > current ? current : null,
    originalPrice: originalCandidate && current && originalCandidate > current ? originalCandidate : null,
  };
}

function inferSize(name) {
  const text = String(name || '').replace(/,/g, '.');
  const multiKg = text.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*kg\b/i);
  if (multiKg) {
    const count = Number(multiKg[1]); const unit = Number(multiKg[2]);
    return { size: `${count}x${unit}kg`, sizeKg: Number((count * unit).toFixed(3)), variant: `${count}x${unit}kg` };
  }
  const multiGram = text.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*g\b/i);
  if (multiGram) {
    const count = Number(multiGram[1]); const unit = Number(multiGram[2]);
    return { size: `${count}x${unit}g`, sizeKg: Number((count * unit / 1000).toFixed(3)), variant: `${count}x${unit}g` };
  }
  const kg = text.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
  if (kg) return { size: `${Number(kg[1])}kg`, sizeKg: Number(kg[1]), variant: `${Number(kg[1])}kg` };
  const grams = text.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (grams) {
    const value = Number(grams[1]);
    return { size: `${value}g`, sizeKg: Number((value / 1000).toFixed(3)), variant: `${value}g` };
  }
  return { size: '', sizeKg: null, variant: 'unspecified' };
}

function buildIdentity(product, config) {
  const rawUrl = product.url || product.targetUrl || product.canonicalUrl;
  const canonicalUrl = canonicalizeProductUrl(rawUrl, config);
  const targetUrl = preserveAffiliateTargetUrl(product.targetUrl || product.url || canonicalUrl, config);
  const size = inferSize(product.name);
  const canonicalIdentity = `${canonicalUrl}|${size.variant}`;
  const sourceProductId = String(product.sourceProductId || '').trim();
  const sourceIdentity = sourceProductId ? `superzoo-product:${sourceProductId}` : canonicalUrl;
  const productIdentity = `${sourceIdentity}|${size.variant}`;
  const label = sourceProductId || new URL(canonicalUrl).pathname.split('/').filter(Boolean).pop() || 'product';
  return {
    canonicalUrl,
    targetUrl,
    canonicalIdentity,
    sourceProductId: sourceProductId || null,
    sourceIdentity,
    sourceId: sourceProductId || null,
    productId: `superzoo-${sourceProductId ? 'id' : 'url'}-${slugify(label, 48)}-${sha256(productIdentity).slice(0, 12)}`,
    size,
  };
}

function exclusionReason(product, config) {
  if (product.id && config.catalogExclusionContract.legacyExcludedProductIds.includes(product.id)) return 'legacy_product_id';
  const rawUrl = product.url || product.targetUrl || product.canonicalUrl;
  if (rawUrl) {
    try {
      const canonicalUrl = canonicalizeProductUrl(rawUrl, config);
      const excludedUrls = new Set(config.catalogExclusionContract.superZooExcludedCanonicalUrls.map(url => canonicalizeProductUrl(url, config)));
      if (excludedUrls.has(canonicalUrl)) return 'stable_source_url';
    } catch {
      // URL validity is reported by the validator separately.
    }
  }
  const name = String(product.name || '');
  if (config.sourcePolicy.forbiddenNamePatterns.some(pattern => new RegExp(pattern, 'iu').test(name))) return 'forbidden_name';
  const category = String(product.category || '');
  if (config.sourcePolicy.forbiddenCategoryPatterns.some(pattern => new RegExp(pattern, 'iu').test(category))) return 'forbidden_category';
  return null;
}

function isOutOfScope(product, config) {
  return exclusionReason(product, config) !== null;
}

function buildAffiliateUrl(targetUrl, config) {
  const safeTarget = preserveAffiliateTargetUrl(targetUrl, config);
  return `${CJ_AFFILIATE_PREFIX}${encodeURIComponent(safeTarget)}`;
}

function validateAffiliateUrlDetailed(affiliateUrl, config) {
  try {
    const parsed = new URL(affiliateUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.dpbolvw.net' || parsed.port || parsed.username || parsed.password
        || parsed.pathname !== '/click-101752886-12607708' || parsed.hash) return { valid: false, reason: 'invalid_affiliate_wrapper' };
    const keys = [...parsed.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'url' || parsed.searchParams.getAll('url').length !== 1) return { valid: false, reason: 'unexpected_affiliate_parameters' };
    const target = parsed.searchParams.get('url');
    if (!target) return { valid: false, reason: 'missing_destination' };
    preserveAffiliateTargetUrl(target, config);
    if (affiliateUrl !== `${CJ_AFFILIATE_PREFIX}${encodeURIComponent(target)}`) return { valid: false, reason: 'destination_not_single_encoded' };
    return { valid: true, reason: null, targetUrl: target };
  } catch (error) {
    return { valid: false, reason: 'invalid_destination', detail: redactDiagnosticText(error) };
  }
}

function validateAffiliateUrl(affiliateUrl, config) { return validateAffiliateUrlDetailed(affiliateUrl, config).valid; }

function decodeDiagnosticPercentLayers(value) {
  let decoded = value;
  for (let depth = 0; depth < MAX_PERCENT_DECODE_ROUNDS; depth += 1) {
    if (!/%[0-9a-f]{2}/iu.test(decoded)) return { decoded, unstable: false };
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, sequence => {
      try { return decodeURIComponent(sequence); } catch { return sequence.replace(/%([0-7][0-9a-f])/giu, (match, hex) => String.fromCharCode(Number.parseInt(hex, 16))); }
    });
    if (next === decoded) return { decoded, unstable: false };
    decoded = next;
  }
  return { decoded, unstable: /%[0-9a-f]{2}/iu.test(decoded) };
}

function isSensitiveDiagnosticName(value) {
  let text;
  try { text = String(value ?? ''); } catch { return true; }
  const decoded = decodeDiagnosticPercentLayers(text);
  if (decoded.unstable) return true;
  const candidate = decoded.decoded.replace(/^[?&\s]+/u, '').split(/[=:]/u, 1)[0];
  return SENSITIVE_DIAGNOSTIC_NAMES.has(normalizeParameterName(candidate));
}

function isSensitivePropertyName(value) {
  let text;
  try { text = String(value ?? ''); } catch { return true; }
  const decoded = decodeDiagnosticPercentLayers(text);
  if (decoded.unstable) return true;
  return SENSITIVE_DIAGNOSTIC_NAMES.has(normalizeParameterName(decoded.decoded));
}

function redactDiagnosticText(value) {
  let text;
  try { text = String(value ?? ''); } catch { return '[Unprintable diagnostic value]'; }
  if (text.length > 1024 * 1024) text = `${text.slice(0, 1024 * 1024)}[Diagnostic truncated]`;
  const decoded = decodeDiagnosticPercentLayers(text);
  if (decoded.unstable) return '[REDACTED_UNSTABLE_DIAGNOSTIC]';
  text = decoded.decoded;
  const sensitiveName = '(?:api[\\s_-]*key|access[\\s_-]*token|auth|password|passwd|secret|token|client[\\s_-]*secret|private[\\s_-]*key|session[\\s_-]*id)';
  text = text.replace(/\b(?:ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/giu, '[REDACTED]');
  text = text.replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@');
  text = text.replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu, '[REDACTED_CREDENTIAL]');
  text = text.replace(/\bbearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]');
  text = text.replace(new RegExp(`([?&]${sensitiveName}\\s*=)[^&#\\s]*`, 'giu'), '$1[REDACTED]');
  text = text.replace(new RegExp(`\\b${sensitiveName}\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, 'giu'), '[REDACTED_CREDENTIAL]');
  if (/%(?![0-9a-f]{2})/iu.test(text)) {
    const malformedClassification = text.replace(/%[^\s]{0,2}/gu, '');
    if (new RegExp(`\\b(?:authorization|bearer|${sensitiveName})\\b`, 'iu').test(malformedClassification)) return '[REDACTED_MALFORMED_DIAGNOSTIC]';
  }
  if (isSensitiveDiagnosticName(text)) return '[REDACTED_CREDENTIAL]';
  return text;
}

function serializeDiagnosticError(error, depth = 0, seen = new WeakSet()) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    if (seen.has(error)) return { name: 'CircularReference', message: '[Circular]' };
    seen.add(error);
  }
  const safeRead = (target, property) => { try { return target?.[property]; } catch { return undefined; } };
  const name = safeRead(error, 'name');
  const message = safeRead(error, 'message');
  const result = {
    name: redactDiagnosticText(name || 'Error').slice(0, 200),
    message: redactDiagnosticText(message || error || 'Unknown error').slice(0, 2000),
  };
  const stack = safeRead(error, 'stack');
  if (stack) result.stack = redactDiagnosticText(stack).slice(0, 8000);
  const cause = safeRead(error, 'cause');
  if (cause !== undefined && depth < 8) result.cause = serializeDiagnosticError(cause, depth + 1, seen);
  const errors = safeRead(error, 'errors');
  if (errors !== undefined && depth < 8) {
    let values;
    try { values = Array.from(errors).slice(0, 50); } catch { values = [errors]; }
    result.errors = values.map(item => serializeDiagnosticError(item, depth + 1, seen));
  }
  return result;
}

function normalizeRawProduct(product, config) {
  const identity = buildIdentity(product, config);
  const prices = resolvePrices(product);
  let image = String(product.image || '').trim();
  try { image = new URL(image, identity.targetUrl).toString(); } catch { image = ''; }
  let affiliateUrl = buildAffiliateUrl(identity.targetUrl, config);
  if (product.affiliateUrl) {
    const existing = validateAffiliateUrlDetailed(product.affiliateUrl, config);
    if (existing.valid && canonicalizeProductUrl(existing.targetUrl, config) === identity.canonicalUrl) {
      affiliateUrl = String(product.affiliateUrl).trim();
    }
  }
  const rawAvailability = product?.availability;
  const availabilityText = typeof rawAvailability?.rawText === 'string' ? rawAvailability.rawText.replace(/\s+/g, ' ').trim() : '';
  const availability = {
    status: rawAvailability?.status === 'in_stock' ? 'in_stock' : 'unknown',
    rawText: availabilityText || null,
  };
  return {
    sourceProductId: identity.sourceProductId,
    sourceId: identity.sourceId,
    sourceIdentity: identity.sourceIdentity,
    canonicalIdentity: identity.canonicalIdentity,
    canonicalUrl: identity.canonicalUrl,
    targetUrl: identity.targetUrl,
    name: String(product.name || '').trim(),
    price: prices.price,
    salePrice: prices.salePrice,
    originalPrice: prices.originalPrice,
    url: identity.targetUrl,
    affiliateUrl,
    image,
    availability,
    category: String(product.category || '').trim(),
    animalType: String(product.animalType || '').trim(),
    size: identity.size.size,
    sizeKg: identity.size.sizeKg,
    scrapedAt: product.scrapedAt || new Date().toISOString(),
  };
}

function countByCategory(products) {
  return products.reduce((counts, product) => {
    counts[product.category] = (counts[product.category] || 0) + 1;
    return counts;
  }, {});
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH) { return readJson(configPath); }

module.exports = {
  CJ_AFFILIATE_PREFIX, DEFAULT_CONFIG_PATH, PROTECTED_FIXTURE_PATHS, assertSafeOutputPath, buildAffiliateUrl, buildIdentity,
  canonicalizeProductUrl, countByCategory, exclusionReason, inferSize, isOutOfScope, loadConfig,
  normalizeIdentityPath, normalizeRawProduct, normalizeText, parseCliArgs, parseMoney, parseSuperZooUrl,
  preserveAffiliateTargetUrl, readJson, redactDiagnosticText, resolvePrices, serializeDiagnosticError,
  redactDiagnosticValue, sha256, slugify, validateAffiliateUrl, validateAffiliateUrlDetailed, writeJson, writeJsonAtomic, writeTextAtomic,
};
