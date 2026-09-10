import React, { useState } from 'react';
import {
  DIALOGUE_LANGUAGES,
  detectLanguage,
  suggestDialogueLanguage,
} from '../lib/voiceover';
import { Package } from 'lucide-react';
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from './ui';
import { useI18n } from '../lib/i18n-context';

interface ProductInputProps {
  onSubmit: (
    productName: string,
    productDescription: string,
    dialogueLanguage: string
  ) => void;
  isSubmitting: boolean;
  /** Pre-filled from a project item (Stage 10) — still editable here. */
  initialName?: string | null;
  initialDescription?: string | null;
  /** Voice-over language (spec §13): saved choice / project market language. */
  initialDialogueLanguage?: string | null;
  marketLanguage?: string | null;
}

const MAX_NAME_LENGTH = 100;
const MIN_NAME_LENGTH = 3;
const MAX_DESCRIPTION_LENGTH = 500;
const MIN_DESCRIPTION_LENGTH = 1;

/**
 * ProductInput — the per-Session "Product Info" step of the generation
 * workflow (spec §1). A project-bound session (Stage 10) arrives with
 * `initialName`/`initialDescription` copied from the ProductItem; the
 * hand-typed form stays for the anonymous quick path.
 */
export const ProductInput: React.FC<ProductInputProps> = ({
  onSubmit,
  isSubmitting,
  initialName,
  initialDescription,
  initialDialogueLanguage,
  marketLanguage,
}) => {
  const { dict } = useI18n();
  const [productName, setProductName] = useState(initialName ?? '');
  const [productDescription, setProductDescription] = useState(
    (initialDescription ?? '').slice(0, MAX_DESCRIPTION_LENGTH)
  );
  // Spec §13: the dropdown starts from the saved choice, else the project's
  // market language, else the script of the (typed or dictated) description.
  const suggested = suggestDialogueLanguage({
    chosen: initialDialogueLanguage,
    countryLanguage: marketLanguage,
    description: initialDescription,
    name: initialName,
  });
  const [dialogueLanguage, setDialogueLanguage] = useState(suggested.code);
  const [languageTouched, setLanguageTouched] = useState(false);
  const liveGuess =
    !languageTouched && !initialDialogueLanguage && !marketLanguage
      ? suggestDialogueLanguage({
          description: productDescription,
          name: productName,
        })
      : null;
  const effectiveLanguage = liveGuess ? liveGuess.code : dialogueLanguage;
  const [nameError, setNameError] = useState('');
  const [descriptionError, setDescriptionError] = useState('');

  const validateName = (value: string): boolean => {
    if (value.length < MIN_NAME_LENGTH) {
      setNameError(
        dict.productInput.nameTooShort.replace(
          '{{min}}',
          String(MIN_NAME_LENGTH)
        )
      );
      return false;
    }
    if (value.length > MAX_NAME_LENGTH) {
      setNameError(
        dict.productInput.nameTooLong.replace(
          '{{max}}',
          String(MAX_NAME_LENGTH)
        )
      );
      return false;
    }
    setNameError('');
    return true;
  };

  const validateDescription = (value: string): boolean => {
    if (value.length < MIN_DESCRIPTION_LENGTH) {
      setDescriptionError(dict.productInput.descriptionEmpty);
      return false;
    }
    if (value.length > MAX_DESCRIPTION_LENGTH) {
      setDescriptionError(
        dict.productInput.descriptionTooLong.replace(
          '{{max}}',
          String(MAX_DESCRIPTION_LENGTH)
        )
      );
      return false;
    }
    setDescriptionError('');
    return true;
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setProductName(value);
    if (value.length > 0) validateName(value);
    else setNameError('');
  };

  const handleDescriptionChange = (
    e: React.ChangeEvent<HTMLTextAreaElement>
  ) => {
    const value = e.target.value;
    setProductDescription(value);
    if (value.length > 0) validateDescription(value);
    else setDescriptionError('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const isNameValid = validateName(productName);
    const isDescriptionValid = validateDescription(productDescription);
    if (isNameValid && isDescriptionValid) {
      onSubmit(productName, productDescription, effectiveLanguage);
    }
  };

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Package size={18} className="text-accent" />}
        title={dict.productInput.title}
        hint={dict.productInput.hint}
      />
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          label={dict.productInput.nameLabel}
          htmlFor="productName"
          error={nameError}
          hint={dict.productInput.nameHint
            .replace('{{min}}', String(MIN_NAME_LENGTH))
            .replace('{{max}}', String(MAX_NAME_LENGTH))}
          counter={`${productName.length}/${MAX_NAME_LENGTH}`}
        >
          <Input
            id="productName"
            value={productName}
            onChange={handleNameChange}
            disabled={isSubmitting}
            invalid={!!nameError}
            placeholder={dict.productInput.namePlaceholder}
            maxLength={MAX_NAME_LENGTH}
          />
        </Field>

        <Field
          label={dict.productInput.descriptionLabel}
          htmlFor="productDescription"
          error={descriptionError}
          hint={dict.productInput.descriptionHint.replace(
            '{{max}}',
            String(MAX_DESCRIPTION_LENGTH)
          )}
          counter={`${productDescription.length}/${MAX_DESCRIPTION_LENGTH}`}
        >
          <Textarea
            id="productDescription"
            value={productDescription}
            onChange={handleDescriptionChange}
            disabled={isSubmitting}
            invalid={!!descriptionError}
            rows={4}
            placeholder={dict.productInput.descriptionPlaceholder}
            maxLength={MAX_DESCRIPTION_LENGTH}
          />
        </Field>

        <Field
          label={dict.productInput.languageLabel}
          htmlFor="dialogueLanguage"
          hint={
            languageTouched
              ? dict.productInput.languageHintManual
              : (liveGuess ?? suggested).source === 'country'
                ? detectLanguage(productDescription) &&
                  detectLanguage(productDescription) !== effectiveLanguage
                  ? dict.productInput.languageHintCountryMismatch
                  : dict.productInput.languageHintCountry
                : (liveGuess ?? suggested).source === 'description'
                  ? dict.productInput.languageHintDescription
                  : (liveGuess ?? suggested).source === 'user'
                    ? dict.productInput.languageHintUser
                    : dict.productInput.languageHintUnknown
          }
        >
          <Select
            id="dialogueLanguage"
            value={effectiveLanguage}
            onChange={(e) => {
              setLanguageTouched(true);
              setDialogueLanguage(e.target.value);
            }}
            disabled={isSubmitting}
          >
            {DIALOGUE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
            {!DIALOGUE_LANGUAGES.some((l) => l.code === effectiveLanguage) && (
              <option value={effectiveLanguage}>{effectiveLanguage}</option>
            )}
          </Select>
        </Field>

        <Button
          block
          size="lg"
          type="submit"
          loading={isSubmitting}
          disabled={
            isSubmitting ||
            !productName ||
            !productDescription ||
            !!nameError ||
            !!descriptionError
          }
        >
          {isSubmitting ? dict.productInput.saving : dict.productInput.continue}
        </Button>
      </form>
    </Card>
  );
};
