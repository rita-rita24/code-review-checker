export * as acorn from 'acorn';
export * as acornLoose from 'acorn-loose';
import JavaLexer from '../node_modules/java-parser/src/lexer.js';
import JavaParser from '../node_modules/java-parser/src/parser.js';
import { EOF, tokenMatcher } from 'chevrotain';

// Keep Java parser initialization lazy; JavaScript-only reviews do not need it.
// The pinned parser's internal entry points allow whole files and pasted fragments.
let javaParser;
let lookaheadCount = 0;
let lookaheadLimit = Infinity;
let parseDeadline = Infinity;
const exhausted = new Error('Java parser work budget exhausted');

function getJavaParser() {
  if (!javaParser) {
    javaParser = new JavaParser();
    const lookahead = javaParser.LA;
    // The parser's speculative lookahead can revisit deeply nested, unfinished
    // generic types many times. Bound that work, including in the UI fallback.
    javaParser.LA = function (distance) {
      lookaheadCount++;
      if (lookaheadCount > lookaheadLimit || (lookaheadCount & 255) === 0 && Date.now() > parseDeadline) throw exhausted;
      return lookahead.call(this, distance);
    };
  }
  return javaParser;
}

export function parseJava(source) {
  const attempts = [
    { source, entry: 'compilationUnit', offset: 0 },
    { source: `{${source}}`, entry: 'classBody', offset: 1 },
    { source: `{${source}}`, entry: 'block', offset: 1 }
  ];
  const parser = getJavaParser();
  lookaheadCount = 0;
  parseDeadline = Date.now() + 1000;
  lookaheadLimit = Infinity;
  try {
    for (const attempt of attempts) {
      const lexed = JavaLexer.tokenize(attempt.source);
      if (lexed.errors.length) continue;
      lookaheadLimit = Math.max(250000, lexed.tokens.length * 100);
      parser.input = lexed.tokens;
      try {
        const cst = parser[attempt.entry]();
        if (!parser.errors.length && tokenMatcher(parser.LA(1), EOF)) {
          return { cst, tokens: lexed.tokens, comments: lexed.groups.comments, offset: attempt.offset };
        }
      } catch (error) {
        if (error === exhausted) return null;
        if (!(error instanceof RangeError)) throw error;
      }
    }
  } finally {
    // Release source tokens and reset aborted parser state for the next input.
    lookaheadLimit = parseDeadline = Infinity;
    parser.input = [];
  }
  return null;
}
