import { Transform } from 'class-transformer';
import { Matches, ValidationOptions } from 'class-validator';

/**
 * C0/C1 control characters and DEL. Display strings (titles, folder names,
 * descriptions) must not contain them; they are useless in text and are a
 * classic vector for log injection and terminal escape tricks.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

export function containsControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

/** Trims string inputs; non-strings pass through to fail `@IsString()`. */
export const TrimString = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  );

// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARACTERS = /^[^\u0000-\u001F\u007F-\u009F]*$/;
/** Same, but tab, LF and CR are allowed (multi-line text such as descriptions). */
const NO_CONTROL_CHARACTERS_MULTILINE =
  // eslint-disable-next-line no-control-regex
  /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]*$/;

/** Rejects strings containing control characters. */
export const NoControlCharacters = (
  options: ValidationOptions & { allowLineBreaks?: boolean } = {},
) => {
  const { allowLineBreaks, ...validationOptions } = options;
  return Matches(
    allowLineBreaks ? NO_CONTROL_CHARACTERS_MULTILINE : NO_CONTROL_CHARACTERS,
    {
      message: '$property must not contain control characters',
      ...validationOptions,
    },
  );
};

/**
 * Query strings cannot express `null`; the literal `null` (or an empty
 * value) is mapped to `null` so clients can ask for root-level items.
 */
export const NullableQueryValue = () =>
  Transform(({ value }) =>
    value === 'null' || value === '' ? null : (value as unknown),
  );
