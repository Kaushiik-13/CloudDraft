// Resolves the icon names people (and language models) naturally write, such as
// "aws-s3", "S3" or "Amazon SQS", to the names used by the bundled icon catalog.

const PROVIDERS = ['aws', 'gcp'];

// Short or common names whose catalog name differs. Keyed by provider, then by
// the name without its provider prefix.
const ALIASES = {
  aws: {
    s3: 'aws-simple-storage-service',
    sqs: 'aws-simple-queue-service',
    sns: 'aws-simple-notification-service',
    ses: 'aws-simple-email-service',
    ebs: 'aws-elastic-block-store',
    eks: 'aws-elastic-kubernetes-service',
    ecs: 'aws-elastic-container-service',
    ecr: 'aws-elastic-container-registry',
    elb: 'aws-elastic-load-balancing',
    'load-balancer': 'aws-elastic-load-balancing',
    alb: 'aws-elb-application-load-balancer',
    nlb: 'aws-elb-network-load-balancer',
    iam: 'aws-identity-and-access-management',
    kms: 'aws-key-management-service',
    route53: 'aws-route-53',
    'cloud-front': 'aws-cloudfront',
    apigateway: 'aws-api-gateway',
    stepfunctions: 'aws-step-functions',
    'event-bridge': 'aws-eventbridge',
    'dynamo-db': 'aws-dynamodb',
    'secret-manager': 'aws-secrets-manager',
  },
  gcp: {
    gcs: 'gcp-cloud-storage',
    storage: 'gcp-cloud-storage',
    gce: 'gcp-compute-engine',
    gke: 'gcp-google-kubernetes-engine',
    iam: 'gcp-identity-and-access-management',
    kms: 'gcp-key-management-service',
    'pub-sub': 'gcp-pubsub',
    spanner: 'gcp-cloud-spanner',
    'vertex-ai': 'gcp-vertexai',
    'load-balancer': 'gcp-cloud-load-balancing',
  },
};

const PREFIXES = [
  ['aws', 'aws-amazon-'],
  ['aws', 'amazon-web-services-'],
  ['aws', 'amazon-'],
  ['aws', 'aws-'],
  ['gcp', 'gcp-google-cloud-'],
  ['gcp', 'google-cloud-platform-'],
  ['gcp', 'google-cloud-'],
  ['gcp', 'google-'],
  ['gcp', 'gcp-'],
];

export function normalizeIconName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[\s_/.]+/g, '-')
    .replace(/[^a-z0-9&-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function splitProvider(normalized) {
  for (const [provider, prefix] of PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return { provider, core: normalized.slice(prefix.length) };
    }
  }
  return { provider: undefined, core: normalized };
}

/**
 * Returns the catalog name for `name`, or undefined when nothing matches.
 * `names` is an iterable of catalog icon names.
 */
export function resolveIconName(name, names) {
  const catalog = names instanceof Set ? names : new Set(names);
  const normalized = normalizeIconName(name);
  if (!normalized) return undefined;
  if (catalog.has(normalized)) return normalized;
  const { provider, core } = splitProvider(normalized);
  const providers = provider
    ? [provider]
    : PROVIDERS;
  const cores = new Set([core, core.replace(/^amazon-/, ''), core.replaceAll('-', '')]);
  for (const candidateProvider of providers) {
    for (const candidate of cores) {
      const aliased = ALIASES[candidateProvider][candidate];
      if (aliased && catalog.has(aliased)) return aliased;
      const direct = `${candidateProvider}-${candidate}`;
      if (catalog.has(direct)) return direct;
    }
  }
  return undefined;
}

/** Catalog names that look like `query`, best first. */
export function suggestIcons(query, names, limit = 5) {
  const normalized = normalizeIconName(query);
  const { provider, core } = splitProvider(normalized);
  const tokens = core.split('-').filter(Boolean);
  if (!tokens.length) return [];
  const resolved = resolveIconName(query, names);
  const scored = [];
  for (const name of names) {
    if (provider && !name.startsWith(`${provider}-`)) continue;
    const hits = tokens.filter((token) => name.includes(token)).length;
    if (!hits) continue;
    scored.push({ name, score: hits * 100 - name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const ordered = scored.map(({ name }) => name);
  return [...new Set([...(resolved ? [resolved] : []), ...ordered])].slice(0, limit);
}

/** Catalog names matching a search query, including common short names. */
export function searchIcons(query, names, provider) {
  const all = [...names].filter((name) => !provider || name.startsWith(`${provider}-`));
  const needle = normalizeIconName(query);
  if (!needle) return all;
  const exact = all.filter((name) => name.includes(needle));
  const resolved = resolveIconName(query, new Set(all));
  const found = [...new Set([...(resolved ? [resolved] : []), ...exact])];
  return found.length ? found : suggestIcons(query, all, 20);
}
