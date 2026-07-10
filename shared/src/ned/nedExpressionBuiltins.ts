import { CompletionItem, CompletionItemKind, InsertTextFormat } from '../model/completion';

/**
 * Expression-context built-in completion candidates: boolean/NaN/inf-style constants,
 * expression keywords, and operator/function/distribution snippet templates. These are
 * offered (additively, alongside whatever member/param names the surrounding context
 * resolves) whenever the cursor is inside a NED value expression — see
 * `isExpressionContext` / the expression-context branch in `nedCompletion.ts`.
 *
 * Ported verbatim from the Eclipse OMNeT++ IDE:
 *   - ui/org.omnetpp.common/src/org/omnetpp/common/editor/text/Keywords.java
 *     (`BOOL_CONSTANTS`, `NED_EXPR_KEYWORDS`)
 *   - ui/org.omnetpp.common/src/org/omnetpp/common/editor/text/NedCompletionHelper.java
 *     (`proposedNedOperatorsTempl`, `proposedNedFunctionsTempl`,
 *      `proposedNedContinuousDistributionsTempl(Ext)`,
 *      `proposedNedDiscreteDistributionsTempl(Ext)`)
 */

/** Keywords.java: BOOL_CONSTANTS (despite the name, includes all NED literal constants). */
const EXPR_CONSTANTS = ['false', 'true', 'undefined', 'nan', 'inf', 'null', 'nullptr'];

/** Keywords.java: NED_EXPR_KEYWORDS */
const EXPR_KEYWORDS = ['sizeof', 'const', 'default', 'ask', 'this', 'parent', 'index', 'typename'];

interface FnTemplate {
  name: string;
  args: string[];
  detail: string;
}

function fn(name: string, args: string[], detail: string): FnTemplate {
  return { name, args, detail };
}

/** NedCompletionHelper.java: proposedNedOperatorsTempl */
const OPERATOR_TEMPLATES: FnTemplate[] = [
  fn('const', ['x'], 'operator'),
  fn('default', ['x'], 'operator'),
  fn('sizeof', ['gateOrSubmod'], 'operator'),
];

/** NedCompletionHelper.java: proposedNedFunctionsTempl */
const FUNCTION_TEMPLATES: FnTemplate[] = [
  // math
  fn('acos', ['x'], 'function'),
  fn('asin', ['x'], 'function'),
  fn('atan', ['x'], 'function'),
  fn('atan2', ['x', 'y'], 'function'),
  fn('sin', ['x'], 'function'),
  fn('cos', ['x'], 'function'),
  fn('tan', ['x'], 'function'),
  fn('ceil', ['x'], 'function'),
  fn('floor', ['x'], 'function'),
  fn('max', ['a', 'b'], 'function'),
  fn('min', ['a', 'b'], 'function'),
  fn('exp', ['x'], 'function'),
  fn('pow', ['x', 'y'], 'function'),
  fn('sqrt', ['x'], 'function'),
  fn('fabs', ['x'], 'function'),
  fn('fmod', ['x', 'y'], 'function'),
  fn('hypot', ['x', 'y'], 'function'),
  fn('log', ['x'], 'function'),
  fn('log10', ['x'], 'function'),

  // unit
  fn('dropUnit', ['quantity'], 'function'),
  fn('replaceUnit', ['quantity', 'string'], 'function'),
  fn('convertUnit', ['quantity', 'string'], 'function'),
  fn('unitOf', ['quantity'], 'function'),

  // string
  fn('length', ['string'], 'function'),
  fn('contains', ['string', 'string'], 'function'),
  fn('substring', ['string', 'int'], 'function'),
  fn('substring', ['string', 'int', 'int'], 'function'),
  fn('substringBefore', ['string', 'string'], 'function'),
  fn('substringAfter', ['string', 'string'], 'function'),
  fn('substringBeforeLast', ['string', 'string'], 'function'),
  fn('substringAfterLast', ['string', 'string'], 'function'),
  fn('startsWith', ['string', 'string'], 'function'),
  fn('endsWith', ['string', 'string'], 'function'),
  fn('tail', ['string', 'int'], 'function'),
  fn('replace', ['string', 'string', 'string'], 'function'),
  fn('replace', ['string', 'string', 'string', 'int'], 'function'),
  fn('replaceFirst', ['string', 'string', 'string'], 'function'),
  fn('replaceFirst', ['string', 'string', 'string', 'int'], 'function'),
  fn('trim', ['string'], 'function'),
  fn('indexOf', ['string'], 'function'),
  fn('choose', ['int', 'string'], 'function'),
  fn('toUpper', ['string'], 'function'),
  fn('toLower', ['string'], 'function'),

  // conversion
  fn('int', ['x'], 'function'),
  fn('double', ['x'], 'function'),
  fn('string', ['x'], 'function'),

  // reflection
  fn('fullPath', [], 'function'),
  fn('fullName', [], 'function'),
  fn('parentIndex', [], 'function'),
  fn('ancestorIndex', ['int'], 'function'),

  // xml
  fn('xml', ['string', 'opt_xpath'], 'function'),
  fn('xmldoc', ['filename', 'opt_xpath'], 'function'),

  // misc
  fn('simTime', [], 'function'),
];

/** NedCompletionHelper.java: proposedNedContinuousDistributionsTempl */
const CONTINUOUS_DISTRIBUTION_TEMPLATES: FnTemplate[] = [
  fn('beta', ['alpha1', 'alpha2'], 'continuous distribution'),
  fn('cauchy', ['a', 'b'], 'continuous distribution'),
  fn('chi_square', ['k'], 'continuous distribution'),
  fn('erlang_k', ['k', 'mean'], 'continuous distribution'),
  fn('exponential', ['mean'], 'continuous distribution'),
  fn('gamma_d', ['alpha', 'beta'], 'continuous distribution'),
  fn('lognormal', ['m', 'w'], 'continuous distribution'),
  fn('normal', ['mean', 'stddev'], 'continuous distribution'),
  fn('pareto_shifted', ['a', 'b', 'c'], 'continuous distribution'),
  fn('student_t', ['i'], 'continuous distribution'),
  fn('triang', ['a', 'b', 'c'], 'continuous distribution'),
  fn('truncnormal', ['mean', 'stddev'], 'continuous distribution'),
  fn('uniform', ['a', 'b'], 'continuous distribution'),
  fn('weibull', ['a', 'b'], 'continuous distribution'),
];

/** NedCompletionHelper.java: proposedNedDiscreteDistributionsTempl */
const DISCRETE_DISTRIBUTION_TEMPLATES: FnTemplate[] = [
  fn('bernoulli', ['p'], 'discrete distribution'),
  fn('binomial', ['n', 'p'], 'discrete distribution'),
  fn('geometric', ['p'], 'discrete distribution'),
  fn('intuniform', ['a', 'b'], 'discrete distribution'),
  fn('negbinomial', ['n', 'p'], 'discrete distribution'),
  fn('poisson', ['lambda'], 'discrete distribution'),
];

/**
 * NedCompletionHelper.java: addRngNumArgument — the `...Ext` distribution variants,
 * which append an extra trailing `rngNum` (RNG index) argument.
 */
function withRngNumArg(templates: FnTemplate[]): FnTemplate[] {
  return templates.map((t) => ({ ...t, args: [...t.args, 'rngNum'] }));
}

function templateItem(t: FnTemplate): CompletionItem {
  const label = `${t.name}(${t.args.join(', ')})`;
  const insertArgs = t.args.map((a, i) => `\${${i + 1}:${a}}`).join(', ');
  return {
    label,
    kind: CompletionItemKind.Function,
    detail: t.detail,
    insertText: `${t.name}(${insertArgs})`,
    insertTextFormat: InsertTextFormat.Snippet,
  };
}

/**
 * All expression built-in candidates: constants, expression keywords, operator
 * templates, distribution templates (base + `...Ext` RNG-index variants), and the
 * general built-in function templates. Order mirrors the Java source's proposal
 * order (`NedCompletionProcessor.java`'s expression-context block).
 */
export function expressionBuiltinCompletions(): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const c of EXPR_CONSTANTS) items.push({ label: c, kind: CompletionItemKind.Value });
  for (const k of EXPR_KEYWORDS) items.push({ label: k, kind: CompletionItemKind.Keyword });
  for (const t of OPERATOR_TEMPLATES) items.push(templateItem(t));
  for (const t of CONTINUOUS_DISTRIBUTION_TEMPLATES) items.push(templateItem(t));
  for (const t of DISCRETE_DISTRIBUTION_TEMPLATES) items.push(templateItem(t));
  for (const t of withRngNumArg(CONTINUOUS_DISTRIBUTION_TEMPLATES)) items.push(templateItem(t));
  for (const t of withRngNumArg(DISCRETE_DISTRIBUTION_TEMPLATES)) items.push(templateItem(t));
  for (const t of FUNCTION_TEMPLATES) items.push(templateItem(t));
  return items;
}
