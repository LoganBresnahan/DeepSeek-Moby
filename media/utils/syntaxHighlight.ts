/**
 * Lightweight syntax highlighter for chat code blocks.
 *
 * Supports ~40 languages via a simple left-to-right scanner.
 * No dependencies — just keyword data + a tokenizer engine.
 *
 * Token types: hl-keyword, hl-string, hl-comment, hl-number,
 *              hl-type, hl-builtin, hl-tag, hl-attr, hl-property, hl-selector
 */

import { createLogger } from '../logging';

const log = createLogger('SyntaxHL');

// Track unknown languages to avoid repeated warnings
const _warnedLangs = new Set<string>();

// ============================================
// Types
// ============================================

interface LangDef {
  /** Space-separated keywords */
  kw: string;
  /** Space-separated type names (optional) */
  ty?: string;
  /** Space-separated built-in functions (optional) */
  bi?: string;
  /** Line comment start (e.g. '//', '#', '--') */
  lc?: string;
  /** Block comment [start, end] */
  bc?: [string, string];
  /** Has triple-quote strings (Python, Julia, Kotlin) */
  tq?: boolean;
  /** '#' starts preprocessor directives, not comments (C/C++) */
  pp?: boolean;
}

// Cached sets per language (lazy init)
const _cache = new Map<string, { kw: Set<string>; ty: Set<string> | null; bi: Set<string> | null }>();

function getSets(def: LangDef) {
  let c = _cache.get(def.kw);
  if (!c) {
    c = {
      kw: new Set(def.kw.split(' ')),
      ty: def.ty ? new Set(def.ty.split(' ')) : null,
      bi: def.bi ? new Set(def.bi.split(' ')) : null,
    };
    _cache.set(def.kw, c);
  }
  return c;
}

// ============================================
// HTML escaping
// ============================================

function esc(ch: string): string {
  switch (ch) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    default: return ch;
  }
}

function escStr(s: string): string {
  let r = '';
  for (let i = 0; i < s.length; i++) r += esc(s[i]);
  return r;
}

// ============================================
// Main entry point
// ============================================

export function highlightCode(code: string, language: string): string {
  const lang = (language || '').toLowerCase().trim();

  // No highlighting for plain text or unknown
  if (!lang || lang === 'text' || lang === 'plaintext') {
    return escStr(code).replace(/\n/g, '&#10;');
  }

  try {
    // Special modes
    const resolved = ALIASES[lang] || lang;
    let result: string;

    if (resolved === 'html' || resolved === 'xml' || resolved === 'svg') {
      result = highlightMarkup(code);
    } else if (resolved === 'css' || resolved === 'scss' || resolved === 'less') {
      result = highlightCss(code);
    } else {
      const def = LANGUAGES[resolved];
      if (!def) {
        if (!_warnedLangs.has(lang)) {
          _warnedLangs.add(lang);
          log.debug(`no syntax def for "${lang}" — rendering as plain text`);
        }
        return escStr(code).replace(/\n/g, '&#10;');
      }
      result = highlightStandard(code, def);
    }

    return result.replace(/\n/g, '&#10;');
  } catch (e) {
    log.warn(`highlight error for "${lang}": ${e instanceof Error ? e.message : e}`);
    return escStr(code).replace(/\n/g, '&#10;');
  }
}

// ============================================
// Standard tokenizer (keyword-based languages)
// ============================================

function highlightStandard(code: string, def: LangDef): string {
  const { kw, ty, bi } = getSets(def);
  const len = code.length;
  let result = '';
  let i = 0;

  while (i < len) {
    const ch = code[i];

    // 1. Block comment
    if (def.bc && code.startsWith(def.bc[0], i)) {
      const endIdx = code.indexOf(def.bc[1], i + def.bc[0].length);
      const endPos = endIdx === -1 ? len : endIdx + def.bc[1].length;
      result += `<span class="hl-comment">${escStr(code.slice(i, endPos))}</span>`;
      i = endPos;
      continue;
    }

    // 2. Line comment
    if (def.lc && code.startsWith(def.lc, i)) {
      const endIdx = code.indexOf('\n', i);
      const endPos = endIdx === -1 ? len : endIdx;
      result += `<span class="hl-comment">${escStr(code.slice(i, endPos))}</span>`;
      i = endPos;
      continue;
    }

    // 3. Preprocessor directives (#include, #define, etc.)
    if (def.pp && ch === '#') {
      const endIdx = code.indexOf('\n', i);
      const endPos = endIdx === -1 ? len : endIdx;
      result += `<span class="hl-keyword">${escStr(code.slice(i, endPos))}</span>`;
      i = endPos;
      continue;
    }

    // 4. Triple-quote strings (Python, Julia, Kotlin, etc.)
    if (def.tq && (ch === '"' || ch === "'") && code.startsWith(ch + ch + ch, i)) {
      const delim = ch + ch + ch;
      const endIdx = code.indexOf(delim, i + 3);
      const endPos = endIdx === -1 ? len : endIdx + 3;
      result += `<span class="hl-string">${escStr(code.slice(i, endPos))}</span>`;
      i = endPos;
      continue;
    }

    // 5. Regular strings
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < len && code[j] !== ch) {
        if (code[j] === '\\') j++; // skip escape
        if (code[j] === '\n' && ch !== '`') break; // single-line string
        j++;
      }
      if (j < len && code[j] === ch) j++; // include closing quote
      result += `<span class="hl-string">${escStr(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // 6. Numbers
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < len && /[0-9]/.test(code[i + 1]))) {
      let j = i;
      if (ch === '0' && i + 1 < len && /[xXbBoO]/.test(code[i + 1])) {
        j += 2;
        while (j < len && /[0-9a-fA-F_]/.test(code[j])) j++;
      } else {
        while (j < len && /[0-9_]/.test(code[j])) j++;
        if (j < len && code[j] === '.') { j++; while (j < len && /[0-9_]/.test(code[j])) j++; }
        if (j < len && /[eE]/.test(code[j])) { j++; if (j < len && /[+-]/.test(code[j])) j++; while (j < len && /[0-9]/.test(code[j])) j++; }
      }
      while (j < len && /[a-zA-Z]/.test(code[j])) j++; // type suffix (f, u, L, etc.)
      result += `<span class="hl-number">${escStr(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // 7. Word (keyword / type / builtin check)
    if (/[a-zA-Z_$@]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_$?!]/.test(code[j])) j++;
      const word = code.slice(i, j);

      if (kw.has(word)) {
        result += `<span class="hl-keyword">${escStr(word)}</span>`;
      } else if (ty?.has(word)) {
        result += `<span class="hl-type">${escStr(word)}</span>`;
      } else if (bi?.has(word)) {
        result += `<span class="hl-builtin">${escStr(word)}</span>`;
      } else {
        result += escStr(word);
      }
      i = j;
      continue;
    }

    // 8. Default character
    result += esc(ch);
    i++;
  }

  return result;
}

// ============================================
// HTML / XML tokenizer
// ============================================

function highlightMarkup(code: string): string {
  const len = code.length;
  let result = '';
  let i = 0;

  while (i < len) {
    // Comment
    if (code.startsWith('<!--', i)) {
      const endIdx = code.indexOf('-->', i + 4);
      const endPos = endIdx === -1 ? len : endIdx + 3;
      result += `<span class="hl-comment">${escStr(code.slice(i, endPos))}</span>`;
      i = endPos;
      continue;
    }

    // DOCTYPE / processing instruction
    if (code.startsWith('<!', i) || code.startsWith('<?', i)) {
      const endIdx = code.indexOf('>', i);
      const endPos = endIdx === -1 ? len : endIdx + 1;
      result += `<span class="hl-keyword">${escStr(code.slice(i, endPos))}</span>`;
      i = endPos;
      continue;
    }

    // Tag (opening or closing)
    if (code[i] === '<' && i + 1 < len && /[a-zA-Z/]/.test(code[i + 1])) {
      // < or </
      let j = i + 1;
      const isClosing = code[j] === '/';
      if (isClosing) j++;

      // Tag name
      const nameStart = j;
      while (j < len && /[a-zA-Z0-9_:-]/.test(code[j])) j++;
      const tagName = code.slice(nameStart, j);

      result += `<span class="hl-tag">${esc('<')}${isClosing ? esc('/') : ''}${escStr(tagName)}</span>`;

      // Attributes
      while (j < len && code[j] !== '>' && !(code[j] === '/' && j + 1 < len && code[j + 1] === '>')) {
        // Whitespace
        if (/\s/.test(code[j])) { result += esc(code[j]); j++; continue; }

        // Attribute name
        const attrStart = j;
        while (j < len && /[a-zA-Z0-9_:@.-]/.test(code[j])) j++;
        if (j > attrStart) {
          result += `<span class="hl-attr">${escStr(code.slice(attrStart, j))}</span>`;
        }

        // = and value
        if (j < len && code[j] === '=') {
          result += esc('=');
          j++;
          if (j < len && (code[j] === '"' || code[j] === "'")) {
            const q = code[j];
            const valEnd = code.indexOf(q, j + 1);
            const endPos = valEnd === -1 ? len : valEnd + 1;
            result += `<span class="hl-string">${escStr(code.slice(j, endPos))}</span>`;
            j = endPos;
          }
        }

        // Safety: skip unrecognized characters
        if (j < len && code[j] !== '>' && !/[\s/a-zA-Z]/.test(code[j])) {
          result += esc(code[j]);
          j++;
        }
      }

      // Self-closing / and >
      if (j < len && code[j] === '/') { result += `<span class="hl-tag">${esc('/')}</span>`; j++; }
      if (j < len && code[j] === '>') { result += `<span class="hl-tag">${esc('>')}</span>`; j++; }

      i = j;
      continue;
    }

    // Entity
    if (code[i] === '&') {
      let j = i + 1;
      while (j < len && j < i + 12 && code[j] !== ';' && /[a-zA-Z0-9#]/.test(code[j])) j++;
      if (j < len && code[j] === ';') {
        j++;
        result += `<span class="hl-number">${escStr(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }
    }

    result += esc(code[i]);
    i++;
  }

  return result;
}

// ============================================
// CSS tokenizer
// ============================================

function highlightCss(code: string): string {
  const len = code.length;
  let result = '';
  let i = 0;
  let braceDepth = 0;

  while (i < len) {
    const ch = code[i];

    // Block comment
    if (code.startsWith('/*', i)) {
      const endIdx = code.indexOf('*/', i + 2);
      const endPos = endIdx === -1 ? len : endIdx + 2;
      result += `<span class="hl-comment">${escStr(code.slice(i, endPos))}</span>`;
      i = endPos;
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < len && code[j] !== ch) { if (code[j] === '\\') j++; j++; }
      if (j < len) j++;
      result += `<span class="hl-string">${escStr(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Braces
    if (ch === '{') { braceDepth++; result += esc(ch); i++; continue; }
    if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); result += esc(ch); i++; continue; }

    // @-rules
    if (ch === '@') {
      let j = i + 1;
      while (j < len && /[a-zA-Z-]/.test(code[j])) j++;
      result += `<span class="hl-keyword">${escStr(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Inside a block: property names (word before :)
    if (braceDepth > 0 && /[a-zA-Z-]/.test(ch)) {
      let j = i;
      while (j < len && /[a-zA-Z-]/.test(code[j])) j++;
      // Look ahead for :
      let k = j;
      while (k < len && /\s/.test(code[k])) k++;
      if (k < len && code[k] === ':') {
        result += `<span class="hl-property">${escStr(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }
      // Not a property, emit as-is
      result += escStr(code.slice(i, j));
      i = j;
      continue;
    }

    // Numbers (inside blocks — values)
    if (braceDepth > 0 && /[0-9.]/.test(ch)) {
      let j = i;
      while (j < len && /[0-9.]/.test(code[j])) j++;
      while (j < len && /[a-zA-Z%]/.test(code[j])) j++; // unit
      result += `<span class="hl-number">${escStr(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Selectors (outside blocks): class and id selectors
    if (braceDepth === 0 && (ch === '.' || ch === '#') && i + 1 < len && /[a-zA-Z_-]/.test(code[i + 1])) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_-]/.test(code[j])) j++;
      result += `<span class="hl-selector">${escStr(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Pseudo-selectors
    if (braceDepth === 0 && ch === ':' && i + 1 < len && /[a-zA-Z]/.test(code[i + 1])) {
      let j = i + 1;
      if (code[j] === ':') j++; // ::pseudo-element
      while (j < len && /[a-zA-Z-]/.test(code[j])) j++;
      result += `<span class="hl-selector">${escStr(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    result += esc(ch);
    i++;
  }

  return result;
}

// ============================================
// Language Definitions
// ============================================

const LANGUAGES: Record<string, LangDef> = {
  // ── Tier 1: Essential ──

  python: {
    kw: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
    bi: 'abs all any bin bool bytes callable chr classmethod complex dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip',
    lc: '#', tq: true,
  },

  javascript: {
    kw: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield',
    bi: 'Array Boolean Date Error Function JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet console decodeURI decodeURIComponent encodeURI encodeURIComponent eval isFinite isNaN parseInt parseFloat require setTimeout setInterval clearTimeout clearInterval fetch',
    lc: '//', bc: ['/*', '*/'],
  },

  typescript: {
    kw: 'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function if implements import in infer instanceof interface is keyof let module namespace never new null of override readonly return satisfies static super switch this throw true try type typeof undefined unique var void while with yield',
    ty: 'any bigint boolean never number object string symbol unknown void',
    bi: 'Array Boolean Date Error Function JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet console decodeURI decodeURIComponent encodeURI encodeURIComponent eval isFinite isNaN parseInt parseFloat require setTimeout setInterval clearTimeout clearInterval fetch Partial Required Readonly Record Pick Omit Exclude Extract NonNullable ReturnType InstanceType Parameters Awaited',
    lc: '//', bc: ['/*', '*/'],
  },

  json: {
    kw: 'true false null',
    lc: undefined,
  },

  bash: {
    kw: 'case do done elif else esac fi for function if in select then until while break continue return exit export local readonly declare typeset unset shift source eval exec trap',
    bi: 'echo printf read cd ls cat grep sed awk find xargs sort uniq wc head tail cut tr tee mkdir rmdir rm cp mv ln chmod chown curl wget git make npm node python pip',
    lc: '#',
  },

  sql: {
    kw: 'ADD ALL ALTER AND AS ASC BEGIN BETWEEN BY CASE CAST CHECK COLUMN COMMIT CONSTRAINT CREATE CROSS CURSOR DATABASE DECLARE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXCEPT EXEC EXECUTE EXISTS FETCH FOREIGN FROM FULL FUNCTION GRANT GROUP HAVING IF IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL OF ON OR ORDER OUTER PRIMARY PROCEDURE PUBLIC REFERENCES RETURN REVOKE RIGHT ROLLBACK ROW ROWNUM SELECT SET TABLE THEN TO TOP TRANSACTION TRIGGER TRUNCATE UNION UNIQUE UPDATE USE USING VALUES VIEW WHEN WHERE WHILE WITH',
    ty: 'BIGINT BIT BINARY BLOB BOOLEAN CHAR CLOB DATE DATETIME DECIMAL FLOAT INT INTEGER LONG MONEY NCHAR NUMERIC NVARCHAR REAL SERIAL SMALLINT TEXT TIME TIMESTAMP TINYINT UUID VARCHAR XML',
    lc: '--', bc: ['/*', '*/'],
  },

  yaml: {
    kw: 'true false null yes no on off',
    lc: '#',
  },

  // ── Tier 2: Common ──

  java: {
    kw: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true false try var void volatile while',
    ty: 'Boolean Byte Character Class Double Float Integer Long Object Short String Thread Void',
    lc: '//', bc: ['/*', '*/'],
  },

  c: {
    kw: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool _Complex _Imaginary',
    ty: 'int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t ssize_t ptrdiff_t bool true false NULL FILE',
    lc: '//', bc: ['/*', '*/'], pp: true,
  },

  cpp: {
    kw: 'alignas alignof and asm auto bitand bitor bool break case catch char class compl concept const consteval constexpr constinit continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false final float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or override private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while',
    ty: 'int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t string vector map set array deque list queue stack pair tuple optional variant unique_ptr shared_ptr weak_ptr',
    lc: '//', bc: ['/*', '*/'], pp: true,
  },

  csharp: {
    kw: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield',
    ty: 'Boolean Byte Char DateTime Decimal Double Enum Exception Guid Int16 Int32 Int64 Object SByte Single String Task Type UInt16 UInt32 UInt64',
    lc: '//', bc: ['/*', '*/'],
  },

  go: {
    kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
    ty: 'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr',
    bi: 'append cap close complex copy delete imag len make new panic print println real recover true false nil iota',
    lc: '//', bc: ['/*', '*/'],
  },

  rust: {
    kw: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
    ty: 'bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Box Rc Arc Option Result HashMap HashSet BTreeMap BTreeSet',
    bi: 'assert assert_eq assert_ne cfg dbg eprint eprintln format include include_bytes include_str macro_rules panic print println todo unimplemented unreachable vec',
    lc: '//', bc: ['/*', '*/'],
  },

  php: {
    kw: 'abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null',
    lc: '//', bc: ['/*', '*/'],
  },

  ruby: {
    kw: '__ENCODING__ __LINE__ __FILE__ BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative include extend prepend attr_reader attr_writer attr_accessor',
    bi: 'puts print p pp gets chomp to_s to_i to_f push pop shift unshift each map select reject reduce sort length size empty? nil? is_a? respond_to? send raise',
    lc: '#',
  },

  swift: {
    kw: 'Any associatedtype break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate for func guard if import in init inout internal is let nil open operator override precedencegroup private protocol public repeat rethrows return self Self static struct subscript super switch throw throws true try typealias var where while async await',
    ty: 'Bool Character Double Float Int Int8 Int16 Int32 Int64 Optional String UInt UInt8 UInt16 UInt32 UInt64 Array Dictionary Set',
    lc: '//', bc: ['/*', '*/'],
  },

  kotlin: {
    kw: 'abstract actual annotation as break by catch class companion const constructor continue crossinline data delegate do dynamic else enum expect external false final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend tailrec this throw true try typealias val var vararg when where while',
    lc: '//', bc: ['/*', '*/'], tq: true,
  },

  xml: {
    // XML uses the markup tokenizer — this def is a fallback
    kw: '',
  },

  markdown: {
    // Markdown doesn't benefit much from keyword highlighting
    kw: '',
    lc: undefined,
  },

  // ── Tier 3: Sometimes ──

  dart: {
    kw: 'abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield',
    lc: '//', bc: ['/*', '*/'],
  },

  lua: {
    kw: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while',
    bi: 'assert collectgarbage dofile error getmetatable ipairs load loadfile next pairs pcall print rawequal rawget rawlen rawset require select setmetatable tonumber tostring type xpcall',
    lc: '--', bc: ['--[[', ']]'],
  },

  r: {
    kw: 'break else for function if in next repeat return while TRUE FALSE NULL NA Inf NaN library require source',
    bi: 'abs acos asin atan c cat cbind ceiling class col colnames cos data dim exp floor grep gsub head ifelse is length list log log2 log10 max mean merge min names nchar nrow paste plot print range rbind read rep rev round rownames sapply seq sort sprintf sqrt str strsplit sub substr sum summary table tail toupper tolower unique which',
    lc: '#',
  },

  scala: {
    kw: 'abstract case catch class def do else extends false final finally for forSome given if implicit import lazy match new null object override package private protected return sealed super then this throw trait true try type using val var while with yield',
    lc: '//', bc: ['/*', '*/'], tq: true,
  },

  haskell: {
    kw: 'as case class data default deriving do else forall foreign hiding if import in infix infixl infixr instance let module newtype of qualified then type where',
    ty: 'Bool Char Double Float IO Int Integer Maybe Either String Ordering',
    lc: '--', bc: ['{-', '-}'],
  },

  elixir: {
    kw: 'after and case catch cond def defimpl defmacro defmodule defoverridable defp defprotocol defstruct do else end false fn for if import in nil not or quote raise receive require rescue return struct super then throw true try unless until use when while with',
    lc: '#',
  },

  erlang: {
    kw: 'after and andalso band begin bnot bor bsl bsr bxor case catch cond div end fun if let not of or orelse receive rem try when xor',
    lc: '%',
  },

  perl: {
    kw: 'chomp chop chroot close closedir defined delete die do dump each else elsif eof eval exec exists exit for foreach format getc glob goto grep if join keys last local map my next no open our package pop pos print printf push redo ref rename require return reverse scalar seek select shift sort splice split sub tie tied truncate undef unless unlink unshift untie until use values wantarray warn while write',
    lc: '#',
  },

  powershell: {
    kw: 'begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in param process return static switch throw trap try until using var while',
    bi: 'Write-Host Write-Output Write-Error Write-Warning Write-Verbose Write-Debug Get-Content Set-Content Add-Content Get-ChildItem Get-Item New-Item Remove-Item Copy-Item Move-Item Test-Path Select-Object Where-Object ForEach-Object Sort-Object Group-Object Measure-Object Compare-Object Import-Module Export-Module',
    lc: '#', bc: ['<#', '#>'],
  },

  visualbasic: {
    kw: 'AddHandler AddressOf Alias And AndAlso As Boolean ByRef Byte ByVal Call Case Catch CBool CByte CChar CDate CDbl CDec Char CInt Class CLng CObj Const Continue CSByte CShort CSng CStr CType CUInt CULng CUShort Date Decimal Declare Default Delegate Dim DirectCast Do Double Each Else ElseIf End EndIf Enum Erase Error Event Exit False Finally For Friend Function Get GetType GetXMLNamespace Global GoSub GoTo Handles If Implements Imports In Inherits Integer Interface Is IsNot Let Lib Like Long Loop Me Mod Module MustInherit MustOverride MyBase MyClass Namespace Narrowing New Next Not Nothing NotInheritable NotOverridable Object Of On Operator Option Optional Or OrElse Overloads Overridable Overrides ParamArray Partial Private Property Protected Public RaiseEvent ReadOnly ReDim REM RemoveHandler Resume Return SByte Select Set Shadows Shared Short Single Static Step Stop String Structure Sub SyncLock Then Throw To True Try TryCast TypeOf UInteger ULong UShort Using Variant Wend When While Widening With WithEvents WriteOnly Xor',
    lc: "'",
  },

  objectivec: {
    kw: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while self super nil Nil NULL YES NO true false id Class SEL IMP BOOL',
    lc: '//', bc: ['/*', '*/'],
  },

  julia: {
    kw: 'abstract baremodule begin break catch ccall const continue do else elseif end export false finally for function global if import in isa let local macro module mutable new primitive quote return struct true try type typealias using while where',
    ty: 'Any Bool Char Complex Float16 Float32 Float64 Int Int8 Int16 Int32 Int64 Int128 Nothing Number Rational Real String Symbol UInt UInt8 UInt16 UInt32 UInt64 UInt128 Vector Matrix Array Dict Set Tuple',
    lc: '#', bc: ['#=', '=#'], tq: true,
  },

  lisp: {
    kw: 'and begin car cdr cond cons defmacro defn defun define defvar do else false fn for format funcall if import in lambda let list loop nil not null or progn quote recur require set setf setq t true when unless',
    lc: ';',
  },

  scheme: {
    kw: 'and begin car cdr case cond define define-syntax delay do else if lambda let let* letrec not or quasiquote quote set! syntax-rules unquote unquote-splicing',
    lc: ';', bc: ['#|', '|#'],
  },

  clojure: {
    kw: 'and as assert catch cond def defmacro defmethod defmulti defn defonce defprotocol defrecord defstruct deftype do else false finally fn for if import in let letfn loop mod new nil not ns or quote recur refer require return throw true try var when while',
    lc: ';',
  },

  toml: {
    kw: 'true false',
    lc: '#',
  },

  dockerfile: {
    kw: 'ADD ARG CMD COPY ENTRYPOINT ENV EXPOSE FROM HEALTHCHECK LABEL MAINTAINER ONBUILD RUN SHELL STOPSIGNAL USER VOLUME WORKDIR AS',
    lc: '#',
  },

  // ── Tier 4: Niche but real ──

  fortran: {
    kw: 'allocatable allocate associate block call case character class close common complex contains continue cycle data deallocate default dimension do double else elseif elsewhere end enddo endfile endif endselect entry equivalence exit external forall format function goto if implicit import include integer intent interface intrinsic logical module namelist none nullify only open operator optional out parameter pause pointer print private program public read real recursive result return rewind save select sequence stop subroutine target then type use where while write',
    lc: '!',
  },

  cobol: {
    kw: 'ACCEPT ADD ALTER CALL CANCEL CLOSE COMPUTE CONTINUE COPY DELETE DISPLAY DIVIDE ELSE END ENTRY EVALUATE EXIT GO GOBACK IF INITIALIZE INSPECT INVOKE MERGE MOVE MULTIPLY OPEN PERFORM READ RELEASE RETURN REWRITE SEARCH SET SORT START STOP STRING SUBTRACT UNSTRING WRITE WHEN SECTION DIVISION PROGRAM PROCEDURE DATA WORKING STORAGE LINKAGE FILE IDENTIFICATION ENVIRONMENT CONFIGURATION INPUT OUTPUT',
    lc: '*>',
  },

  ada: {
    kw: 'abort abs abstract accept access aliased all and array at begin body case constant declare delay delta digits do else elsif end entry exception exit for function generic goto if in interface is limited loop mod new not null of or others out overriding package pragma private procedure protected raise range record rem renames requeue return reverse select separate some subtype synchronized tagged task terminate then type until use when while with xor',
    lc: '--',
  },

  pascal: {
    kw: 'and array as begin case class const constructor destructor div do downto else end except exports file finalization finally for function goto if implementation in inherited initialization interface is label library mod nil not object of or out packed procedure program property raise record repeat resourcestring set shl shr string then threadvar to try type unit until uses var while with xor',
    lc: '//', bc: ['{', '}'],
  },

  prolog: {
    kw: 'is mod not true fail halt dynamic module use_module assert asserta assertz retract abolish findall forall aggregate bagof setof',
    lc: '%', bc: ['/*', '*/'],
  },

  matlab: {
    kw: 'break case catch classdef continue else elseif end enumeration events for function global if methods otherwise parfor persistent properties return spmd switch try while',
    bi: 'abs ceil cos diag disp eig exp eye figure find floor fprintf imag length linspace log log2 log10 max mean min mod norm ones plot prod rand randn real reshape round sin size sort sqrt sum zeros',
    lc: '%', bc: ['%{', '%}'],
  },

  fsharp: {
    kw: 'abstract and as assert base begin class default delegate do done downcast downto elif else end exception extern false finally for fun function global if in inherit inline interface internal lazy let match member module mutable namespace new not null of open or override private public rec return static struct then to true try type upcast use val void when while with yield',
    lc: '//', bc: ['(*', '*)'],
  },

  ocaml: {
    kw: 'and as assert asr begin class constraint do done downto else end exception external false for fun function functor if in include inherit initializer land lazy let lor lsl lsr lxor match method mod module mutable new nonrec object of open or private rec sig struct then to true try type val virtual when while with',
    bc: ['(*', '*)'],
  },

  groovy: {
    kw: 'abstract as assert boolean break byte case catch char class const continue def default do double else enum extends false final finally float for goto if implements import in instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws trait transient true try void volatile while',
    lc: '//', bc: ['/*', '*/'],
  },

  zig: {
    kw: 'align allowzero and anyframe anytype asm break callconv catch comptime const continue defer else enum errdefer error export extern false fn for if inline noalias nosuspend null opaque or orelse packed pub resume return struct suspend switch test threadlocal true try undefined union unreachable usingnamespace var volatile while',
    ty: 'bool f16 f32 f64 f80 f128 i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize void comptime_int comptime_float noreturn type anyerror anyopaque',
    lc: '//',
  },

  d: {
    kw: 'abstract alias align asm assert auto body bool break byte case cast catch char class const continue dchar debug default delegate delete deprecated do double else enum export extern false final finally float for foreach foreach_reverse function goto if immutable import in inout int interface invariant is lazy long mixin module new nothrow null out override package pragma private protected public pure real ref return scope shared short static struct super switch synchronized template this throw true try typeid typeof ubyte uint ulong union unittest ushort version void wchar while with',
    lc: '//', bc: ['/*', '*/'],
  },

  nim: {
    kw: 'addr and as asm bind block break case cast concept const continue converter defer discard distinct div do elif else end enum except export finally for from func if import in include interface is isnot iterator let macro method mixin mod nil not notin object of or out proc ptr raise ref return shl shr static template try tuple type using var when while xor yield',
    lc: '#', bc: ['#[', ']#'],
  },

  solidity: {
    kw: 'abstract address bool break bytes case catch constant constructor continue contract default delete do else emit enum error event external false fallback finally for function if immutable import indexed interface internal is mapping memory modifier new override payable pragma private public pure receive require return returns revert storage string struct this throw true try type uint unchecked using var view virtual while',
    ty: 'address bool bytes bytes1 bytes32 int int8 int16 int32 int64 int128 int256 string uint uint8 uint16 uint32 uint64 uint128 uint256',
    lc: '//', bc: ['/*', '*/'],
  },

  tcl: {
    kw: 'after append apply array break catch cd chan clock close concat continue coroutine dict encoding eof error eval exec exit expr file fileevent flush for foreach format gets glob global if incr info interp join lappend lassign lindex linsert list llength lmap load lrange lrepeat lreplace lreverse lsearch lset lsort namespace open package pid proc puts read regexp regsub rename return scan seek set socket source split string subst switch tailcall tell time trace try unload unset update uplevel upvar variable vwait while',
    lc: '#',
  },

  awk: {
    kw: 'BEGIN END break continue delete do else exit for function getline gsub if in length match next nextfile print printf return split sprintf sub substr system tolower toupper while',
    lc: '#',
  },

  vhdl: {
    kw: 'access after alias all and architecture array assert attribute begin block body buffer bus case component configuration constant disconnect downto else elsif end entity exit file for function generate generic group guarded if impure in inertial inout is label library linkage literal loop map mod nand new next nor not null of on open or others out package port postponed procedure process pure range record register reject rem report return rol ror select severity shared signal sla sll sra srl subtype then to transport type unaffected units until use variable wait when while with xnor xor',
    lc: '--',
  },

  assembly: {
    kw: 'mov push pop call ret jmp je jne jz jnz jg jl jge jle ja jb jae jbe add sub mul imul div idiv and or xor not shl shr sar rol ror cmp test lea inc dec nop int syscall hlt cli sti rep repz repnz movs cmps lods stos scas db dw dd dq resb resw resd resq equ section segment global extern bits org times',
    lc: ';',
  },

  mojo: {
    // Mojo is Python-superset — reuse Python keywords + Mojo extensions
    kw: 'False None True alias and as assert async await break class continue def del elif else except finally fn for from global if import in inout is lambda let nonlocal not or owned pass raise return struct try var while with yield',
    bi: 'abs all any bin bool bytes callable chr classmethod complex dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip',
    lc: '#', tq: true,
  },
};

// ============================================
// Language Aliases
// ============================================

const ALIASES: Record<string, string> = {
  // Tier 1
  js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', ksh: 'bash',
  yml: 'yaml',
  // Tier 2
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', 'c#': 'csharp',
  golang: 'go',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin', kts: 'kotlin',
  // Tier 3
  objc: 'objectivec', 'objective-c': 'objectivec', m: 'objectivec',
  jl: 'julia',
  ex: 'elixir', exs: 'elixir',
  erl: 'erlang',
  pl: 'perl',
  ps1: 'powershell', pwsh: 'powershell',
  vb: 'visualbasic', 'vb.net': 'visualbasic', vbs: 'visualbasic', vbscript: 'visualbasic',
  hs: 'haskell',
  scm: 'scheme', rkt: 'scheme', racket: 'scheme',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
  el: 'lisp', elisp: 'lisp', 'common-lisp': 'lisp', 'emacs-lisp': 'lisp',
  // Tier 4
  fs: 'fsharp', 'f#': 'fsharp',
  ml: 'ocaml',
  pas: 'pascal', delphi: 'pascal', objectpascal: 'pascal',
  asm: 'assembly', nasm: 'assembly', s: 'assembly',
  sol: 'solidity',
  'html5': 'html', htm: 'html',
  svg: 'html',
  // Config/Data
  ini: 'toml',
  makefile: 'bash', make: 'bash',
  // Plain text (no highlighting)
  text: 'text', plaintext: 'text', txt: 'text',
};

// ============================================
// CSS Styles (exported for Shadow DOM injection)
// ============================================

export const syntaxHighlightStyles = `
/* Syntax highlighting — dark theme (default) */
.hl-keyword { color: #569cd6; }
.hl-string { color: #ce9178; }
.hl-comment { color: #6a9955; font-style: italic; }
.hl-number { color: #b5cea8; }
.hl-type { color: #4ec9b0; }
.hl-builtin { color: #dcdcaa; }
.hl-tag { color: #569cd6; }
.hl-attr { color: #9cdcfe; }
.hl-property { color: #9cdcfe; }
.hl-selector { color: #d7ba7d; }

/* Light theme overrides */
:host-context(.vscode-light) .hl-keyword { color: #0000ff; }
:host-context(.vscode-light) .hl-string { color: #a31515; }
:host-context(.vscode-light) .hl-comment { color: #008000; }
:host-context(.vscode-light) .hl-number { color: #098658; }
:host-context(.vscode-light) .hl-type { color: #267f99; }
:host-context(.vscode-light) .hl-builtin { color: #795e26; }
:host-context(.vscode-light) .hl-tag { color: #800000; }
:host-context(.vscode-light) .hl-attr { color: #e50000; }
:host-context(.vscode-light) .hl-property { color: #e50000; }
:host-context(.vscode-light) .hl-selector { color: #800000; }

/* High contrast overrides */
:host-context(.vscode-high-contrast) .hl-keyword { color: #569cd6; }
:host-context(.vscode-high-contrast) .hl-string { color: #ce9178; }
:host-context(.vscode-high-contrast) .hl-comment { color: #7ca668; }
:host-context(.vscode-high-contrast) .hl-number { color: #b5cea8; }
:host-context(.vscode-high-contrast) .hl-type { color: #4ec9b0; }
:host-context(.vscode-high-contrast) .hl-builtin { color: #dcdcaa; }
`;
