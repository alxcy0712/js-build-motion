import { isDeepStrictEqual } from 'node:util';
import { REVIEW_CHECK_IDS, deliveryApprovalHash, validateDelivery, type DeliveryContext, type DeliveryCredits, type DeliveryRequest, type StructuredReview } from './delivery.ts';
import { applicableDecisions, approvalSatisfied } from './production-policy.ts';

const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
const text = (value: string): boolean => value.trim().length > 0;

function current(subject: unknown, context: DeliveryContext): void {
  validateDelivery('subject', context.subject);
  if (!same(subject, context.subject)) throw Error('DELIVERY_SUBJECT_STALE');
}

/** Coverage is combined only within one observation modality and method. */
function full(review: StructuredReview, context: DeliveryContext, method: string, modalities: readonly string[]): boolean {
  return modalities.some(modality => {
    const ranges = review.observations.filter(o => o.method === method && o.modality === modality)
      .sort((a, b) => a.startFrame - b.startFrame);
    let end = 0;
    for (const range of ranges) {
      if (range.startFrame > end) return false;
      end = Math.max(end, range.endFrame);
    }
    return end === context.subject.durationFrames;
  });
}

/** Admit only conclusions supported by the recorded experience of the current bytes. */
export function validateStructuredReview(value: unknown, context: DeliveryContext): StructuredReview {
  const review = validateDelivery<StructuredReview>('review', value);
  current(review.subject, context);
  if (!text(review.reviewer) || !Number.isFinite(Date.parse(review.observedAt))) throw Error('DELIVERY_REVIEW_OBSERVER_INVALID');
  for (const o of review.observations) if (o.startFrame >= o.endFrame || o.endFrame > context.subject.durationFrames || !text(o.tool)) throw Error('DELIVERY_OBSERVATION_RANGE_INVALID');
  if (review.checks.length !== REVIEW_CHECK_IDS.length || new Set(review.checks.map(c => c.checkId)).size !== REVIEW_CHECK_IDS.length) throw Error('DELIVERY_REVIEW_CHECKS_INCOMPLETE');
  const visual = full(review, context, 'normal-speed-playback', ['video', 'audiovisual']);
  const listening = full(review, context, 'actual-listening', ['audio', 'audiovisual']);
  const audiovisual = full(review, context, 'normal-speed-playback', ['audiovisual']);
  for (const check of review.checks) {
    if (!text(check.reason)) throw Error('DELIVERY_REVIEW_REASON_REQUIRED: ' + check.checkId);
    if (check.verdict === 'not_applicable') {
      if (context.subject.audio.master !== null || !['audibility', 'sync'].includes(check.checkId)) throw Error('DELIVERY_REVIEW_NOT_APPLICABLE_INVALID: ' + check.checkId);
      continue;
    }
    if (check.verdict !== 'pass') continue;
    if (['narrative', 'camera', 'rhythm', 'captions', 'quality'].includes(check.checkId) && !visual) throw Error('DELIVERY_FULL_VIEWING_REQUIRED: ' + check.checkId);
    if (check.checkId === 'audibility' && !listening) throw Error('DELIVERY_ACTUAL_LISTENING_REQUIRED');
    if (check.checkId === 'sync' && !audiovisual) throw Error('DELIVERY_AUDIOVISUAL_VIEWING_REQUIRED');
  }
  const shots = new Set(context.bundle.shots?.items.map(s => s.shotId) ?? []);
  for (const r of review.references) {
    if (!text(r.title) || r.url === null && r.file === null || r.url !== null && !text(r.url) || r.endSeconds <= r.startSeconds ||
        !['normal-speed-playback', 'frame-inspection'].includes(r.method) || r.mechanisms.some(m => !text(m)) ||
        new Set(r.appliedShots).size !== r.appliedShots.length || r.appliedShots.some(id => !shots.has(id))) throw Error('DELIVERY_REFERENCE_INVALID');
  }
  return review;
}

/** Each consumed source retains its exact rights record and required attribution. */
export function validateCredits(value: unknown, context: DeliveryContext): DeliveryCredits {
  const credits = validateDelivery<DeliveryCredits>('credits', value);
  current(credits.subject, context);
  const sources = context.subject.sources;
  if (new Set(sources.map(s => s.sourceId)).size !== sources.length || credits.sources.length !== sources.length ||
      new Set(credits.sources.map(s => s.sourceId)).size !== sources.length) throw Error('DELIVERY_RIGHTS_SOURCE_SET_INVALID');
  if (new Set(context.catalogRights.map(r => r.sourceId)).size !== context.catalogRights.length) throw Error('DELIVERY_CATALOG_RIGHTS_DUPLICATE');
  for (const right of credits.sources) {
    const source = sources.find(s => s.sourceId === right.sourceId);
    if (!source || !same(right.file, source.file)) throw Error('DELIVERY_RIGHTS_SOURCE_STALE');
    if (right.status === 'unknown' || right.thirdPartyRightsStatus === 'unknown') throw Error('DELIVERY_RIGHTS_UNKNOWN: ' + right.sourceId);
    if (!right.allowedUses.includes('local-delivery')) throw Error('DELIVERY_RIGHTS_USE_REQUIRED: ' + right.sourceId);
    if (!text(right.restrictionAssessment) || ['unknown', 'pending', 'unverified'].includes(right.restrictionAssessment.trim().toLowerCase())) throw Error('DELIVERY_RESTRICTION_ASSESSMENT_REQUIRED: ' + right.sourceId);
    const catalog = context.catalogRights.find(r => r.sourceId === right.sourceId)?.rights;
    if (source.catalog !== null && !catalog) throw Error('DELIVERY_CATALOG_RIGHTS_REQUIRED: ' + right.sourceId);
    if (catalog && (catalog.byteSha256 !== source.file.sha256 || catalog.status !== right.status || catalog.thirdPartyRightsStatus !== right.thirdPartyRightsStatus ||
        !same(catalog.allowedUses, right.allowedUses) || !same(catalog.restrictions, right.restrictions) || catalog.attribution !== right.requiredAttribution)) throw Error('DELIVERY_CATALOG_RIGHTS_MISMATCH: ' + right.sourceId);
    if (right.requiredAttribution !== null && (!text(right.requiredAttribution) || !credits.attributionLines.includes(right.requiredAttribution))) throw Error('DELIVERY_ATTRIBUTION_REQUIRED: ' + right.sourceId);
  }
  if (credits.attributionLines.some(line => !text(line))) throw Error('DELIVERY_ATTRIBUTION_INVALID');
  return credits;
}

export function assertDeliverable(request: DeliveryRequest, review: unknown, credits: unknown, context: DeliveryContext): { review: StructuredReview; credits: DeliveryCredits } {
  validateDelivery('request', request);
  current(request.subject, context);
  for (const decision of request.approvals) if (!['approval', 'revoke'].includes(decision.kind) || decision.actor !== 'user' || decision.sourcePrompt === null ||
      decision.scope.action !== 'approve' || !['final', 'delivery'].includes(decision.scope.target) || decision.scope.provider !== null ||
      (decision.scope.maxCost ?? 0) !== 0 || decision.scope.assetIds.length) throw Error('DELIVERY_APPROVAL_SCOPE_INVALID');
  const approved = { ...context.bundle, decisions: [...context.bundle.decisions, ...request.approvals] };
  applicableDecisions(approved);
  const checked = { review: validateStructuredReview(review, context), credits: validateCredits(credits, context) };
  for (const check of checked.review.checks) if (!['pass', 'not_applicable'].includes(check.verdict)) throw Error('DELIVERY_REVIEW_INCOMPLETE: ' + check.checkId);
  if (!checked.review.references.some(r => r.method === 'normal-speed-playback')) throw Error('DELIVERY_REFERENCE_PLAYBACK_REQUIRED');
  if (context.consumptionCoverage !== 'partial' || !context.consumptionLimitations.length ||
      context.consumptionLimitations.some(l => !text(l) || !request.knownLimitations.includes(l))) throw Error('DELIVERY_CONSUMPTION_LIMITATIONS_REQUIRED');
  for (const target of ['final', 'delivery'] as const) if (context.bundle.requirements.requested.approvalTasks.includes(target) &&
      !approvalSatisfied(approved, target, deliveryApprovalHash(request, target))) throw Error('DELIVERY_CURRENT_APPROVAL_REQUIRED: ' + target);
  return checked;
}
