// Public surface of the '@omnetpp/shared/match' subpath (see shared/package.json
// "exports") -- OMNeT++'s wildcard pattern matcher and match-expression language,
// ported from C++ (there is no Java source for these; see patternMatcher.ts's and
// matchExpression.ts's file headers, port plan Risk #3).

export { PatternMatcher } from './patternMatcher';
export { MatchExpression, MatchableString, MatchableStringMap, type Matchable } from './matchExpression';
