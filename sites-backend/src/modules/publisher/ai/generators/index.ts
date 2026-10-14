/**
 * AI Publisher — реестр десяти генераторов (P-B2, проектный документ
 * §12.2): четыре допущены в P0 (`enabledInP0` ≡ `P0_ENABLED_GENERATORS`,
 * тест), пять реализованы и выключены — `PUB_AI_DISABLED`, ручной путь
 * (ДТ-2, Р-PUB-31); десятый — `pub.reddit.draft` пакета P-R M2, выключен
 * до живого eval 2.3 (Р-RD-17).
 */
import type { GeneratorId } from '../../contracts/ai';
import { ADAPTATION_MAKE } from './adaptation-make.generator';
import { BRIEF_DRAFT } from './brief-draft.generator';
import { CLAIMS_EXTRACT } from './claims-extract.generator';
import { DISTRIBUTION_PLAN } from './distribution-plan.generator';
import { DRAFT_WRITE } from './draft-write.generator';
import { HELPER_ANSWER } from './helper-answer.generator';
import { QA_REVIEW } from './qa-review.generator';
import { QUESTIONS_CLUSTER } from './questions-cluster.generator';
import { REDDIT_DRAFT } from './reddit-draft.generator';
import type { PubGeneratorSpec } from './spec';
import { VENUES_COMPARE } from './venues-compare.generator';

export const GENERATORS: Readonly<
  Record<GeneratorId, PubGeneratorSpec<unknown, unknown>>
> = {
  'pub.helper.answer': HELPER_ANSWER as PubGeneratorSpec<unknown, unknown>,
  'pub.brief.draft': BRIEF_DRAFT as PubGeneratorSpec<unknown, unknown>,
  'pub.qa.review': QA_REVIEW as PubGeneratorSpec<unknown, unknown>,
  'pub.adaptation.make': ADAPTATION_MAKE as PubGeneratorSpec<unknown, unknown>,
  'pub.questions.cluster': QUESTIONS_CLUSTER as PubGeneratorSpec<
    unknown,
    unknown
  >,
  'pub.draft.write': DRAFT_WRITE as PubGeneratorSpec<unknown, unknown>,
  'pub.claims.extract': CLAIMS_EXTRACT as PubGeneratorSpec<unknown, unknown>,
  'pub.distribution.plan': DISTRIBUTION_PLAN as PubGeneratorSpec<
    unknown,
    unknown
  >,
  'pub.venues.compare': VENUES_COMPARE as PubGeneratorSpec<unknown, unknown>,
  'pub.reddit.draft': REDDIT_DRAFT as PubGeneratorSpec<unknown, unknown>,
};

export {
  ADAPTATION_MAKE,
  BRIEF_DRAFT,
  CLAIMS_EXTRACT,
  DISTRIBUTION_PLAN,
  DRAFT_WRITE,
  HELPER_ANSWER,
  QA_REVIEW,
  QUESTIONS_CLUSTER,
  REDDIT_DRAFT,
  VENUES_COMPARE,
};
