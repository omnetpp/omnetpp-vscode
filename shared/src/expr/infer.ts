import { ExprNode } from './exprParser';

export type ValueType = 'int' | 'double' | 'bool' | 'string' | 'xml' | 'object' | 'unknown';

const NUMERIC = new Set(['int', 'double']);

const FUNC_RETURN: Record<string, ValueType> = {
  xmldoc: 'xml',
  xml: 'xml',
  int: 'int',
  double: 'double',
  string: 'string',
  bool: 'bool',
};

/** Infer the value type of a parsed expression (conservative: 'unknown' when unsure). */
export function inferType(node: ExprNode): { type: ValueType; unit?: string } {
  switch (node.kind) {
    case 'num':
      return { type: node.unit ? 'double' : node.isInt ? 'int' : 'double', unit: node.unit };
    case 'str':
      return { type: 'string' };
    case 'bool':
      return { type: 'bool' };
    case 'special':
      return { type: 'unknown' };
    case 'name':
    case 'index':
    case 'member':
      return { type: 'unknown' };
    case 'call':
      return { type: FUNC_RETURN[node.name] ?? 'unknown' };
    case 'array':
    case 'object':
      return { type: 'object' };
    case 'unary':
      if (node.op === '!') return { type: 'bool' };
      if (node.op === '~') return { type: 'int' };
      return inferType(node.operand); // unary minus preserves numeric
    case 'binary': {
      const op = node.op;
      if (['==', '!=', '<', '>', '<=', '>=', '&&', '||', '^^', 'match'].includes(op))
        return { type: 'bool' };
      if (['<<', '>>', '&', '|', '#', '%'].includes(op)) return { type: 'int' };
      // arithmetic: int if both int, else double; carry unit if present
      const l = inferType(node.left);
      const r = inferType(node.right);
      if (!NUMERIC.has(l.type) && l.type !== 'unknown') return { type: 'unknown' };
      if (!NUMERIC.has(r.type) && r.type !== 'unknown') return { type: 'unknown' };
      const unit = l.unit ?? r.unit;
      if (l.type === 'int' && r.type === 'int') return { type: 'int', unit };
      if (l.type === 'unknown' || r.type === 'unknown') return { type: 'unknown' };
      return { type: 'double', unit };
    }
    case 'ternary': {
      const a = inferType(node.then);
      const b = inferType(node.else);
      if (a.type === b.type) return { type: a.type, unit: a.unit ?? b.unit };
      if (NUMERIC.has(a.type) && NUMERIC.has(b.type)) return { type: 'double' };
      return { type: 'unknown' };
    }
    default:
      return { type: 'unknown' };
  }
}

/**
 * Whether assigning a value of `valueType` to a parameter of `declaredType` is a
 * clear type error. Conservative: returns false unless confidently incompatible.
 */
export function isTypeMismatch(declaredType: string, valueType: ValueType): boolean {
  if (valueType === 'unknown') return false;
  switch (declaredType) {
    case 'string':
      return valueType === 'int' || valueType === 'double' || valueType === 'bool' || valueType === 'xml';
    case 'bool':
      return valueType === 'string' || valueType === 'int' || valueType === 'double' || valueType === 'xml';
    case 'int':
    case 'double':
      return valueType === 'string' || valueType === 'bool' || valueType === 'xml';
    case 'xml':
      return valueType === 'string' || valueType === 'int' || valueType === 'double' || valueType === 'bool';
    case 'object':
      return false;
    default:
      return false;
  }
}
