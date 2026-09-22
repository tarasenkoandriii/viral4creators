/**
 * Экран 1 — Создание проекта (spec §4): type toggle, searchable country
 * (currency derived), title, optional Brand Manifest (§12).
 */

import { useState } from 'react';
import { Gift, Globe, Layers, Package, Search } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Pills,
  Select,
  Textarea,
} from '../../components/ui';
import {
  createProject,
  errorMessage,
  getCountries,
  listBrandManifests,
} from '../../services/projects-api';
import { useAsync } from '../../lib/useAsync';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { CountryPicker } from './CountryPicker';
import { LoadError, ScreenHeader } from './shared';
import type {
  GreetingOccasion,
  GreetingTone,
  ProjectType,
} from '../../types/project';
import {
  GREETING_OCCASIONS,
  allowedTonesFor,
  defaultToneFor,
} from '../../types/project';
import { exploreSite } from '../../services/client-site-tutorial-api';
import { deleteProject } from '../../services/projects-api';

export function ProjectCreateScreen() {
  const { dict } = useI18n();
  const countries = useAsync(getCountries, []);
  // Brand manifests are optional — a failure here must not block Экран 1.
  const manifests = useAsync(() => listBrandManifests().catch(() => []), []);

  const [type, setType] = useState<ProjectType>('SINGLE');
  const [title, setTitle] = useState('');
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [brandManifestId, setBrandManifestId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCountry =
    countries.data?.find((c) => c.code === countryCode) ?? null;
  const canSubmit = title.trim().length > 0 && !!countryCode && !submitting;

  const [siteUrl, setSiteUrl] = useState('');

  // GREETING_VIDEO (ТЗ TZ-Greeting-Video-Project-Type.md) — только то,
  // что нужно для создания бесполезного пустым брифа не бывает: повод и
  // получатель. Ведущий/качество/референсы/текст поздравления — на
  // следующем экране (GreetingVideoWizard), тем же приёмом, что
  // CLIENT_SITE спрашивает название только в конце своего визарда.
  const [occasion, setOccasion] = useState<GreetingOccasion>('BIRTHDAY');
  const [customOccasionText, setCustomOccasionText] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [senderName, setSenderName] = useState('');
  const [tone, setTone] = useState<GreetingTone>('WARM');

  /**
   * Этап 2, фича №3: у чувствительных поводов свой набор тонов, и смена
   * повода может обессмыслить уже выбранный — «С юмором» для
   * соболезнования сервер отвергнет с 400.
   *
   * Переключаем тон на умолчание нового повода ровно тогда, когда
   * прежний стал недопустим, и не трогаем его в остальных случаях: у
   * поводов с обычным набором человек выбрал тон осознанно, и сбрасывать
   * его при каждом переключении повода было бы навязчиво.
   *
   * Это подсказка интерфейса, а не проверка: настоящая живёт на сервере
   * (`GreetingBriefService`/`ProjectService`), потому что визард
   * обходится прямым запросом к API, а она — нет.
   */
  function handleOccasionChange(next: GreetingOccasion) {
    setOccasion(next);
    if (!allowedTonesFor(next).includes(tone)) setTone(defaultToneFor(next));
  }
  const [personalMessage, setPersonalMessage] = useState('');

  const canSubmitGreeting =
    recipientName.trim().length > 0 &&
    (occasion !== 'OTHER' || customOccasionText.trim().length > 0) &&
    !!countryCode &&
    !submitting;

  const submitGreeting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmitGreeting || !countryCode) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject({
        type: 'GREETING_VIDEO',
        // §7.2: страна нужна для локализации TTS/сценария, как у
        // SINGLE/LINE — GREETING_VIDEO не выведен из этого правила
        // (backend `resolveCountryCode` требует её явно для этого типа).
        title:
          `${dict.greetingVideoWizard.occasion[occasion]} — ${recipientName.trim()}`.slice(
            0,
            120
          ),
        countryCode,
        ...(brandManifestId ? { brandManifestId } : {}),
        greetingBrief: {
          occasion,
          ...(occasion === 'OTHER'
            ? { customOccasionText: customOccasionText.trim() }
            : {}),
          recipientName: recipientName.trim(),
          ...(senderName.trim() ? { senderName: senderName.trim() } : {}),
          tone,
          ...(personalMessage.trim()
            ? { personalMessage: personalMessage.trim() }
            : {}),
        },
      });
      navigate(routes.greetingVideo(project.id), true);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  /**
   * Проект «сайт заказчика» заводится ровно в тот момент, когда первое
   * «Исследовать» УДАЛОСЬ (§4.2): неудачный запрос на недоступный домен
   * не должен плодить пустые проекты. Порядок при этом обратный —
   * сначала проект, потом исследование, иначе исследовать нечего: и
   * черновик, и все проверки владения живут при проекте. Поэтому
   * неудача убирает за собой сама.
   *
   * Ни страна, ни название здесь не спрашиваются: страну сервер
   * подставит (для этого типа проекта она ничего не считает), а
   * название спрашивается в конце, когда человек уже видел сайт и может
   * назвать обучалку осмысленно.
   */
  const submitSite = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = siteUrl.trim();
    if (!trimmed || submitting) return;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('scheme');
    } catch {
      setError(dict.clientSiteWizard.urlInvalid);
      return;
    }
    setSubmitting(true);
    setError(null);
    let projectId: string | null = null;
    try {
      const project = await createProject({
        type: 'CLIENT_SITE',
        // Рабочее имя — домен: настоящее название спрашивается в конце
        // визарда, а `Project.title` пустым быть не может.
        title: parsed.hostname.slice(0, 120),
      });
      projectId = project.id;
      await exploreSite(project.id, trimmed);
      navigate(routes.siteTutorial(project.id), true);
    } catch (err) {
      setError(errorMessage(err));
      if (projectId) {
        // Пустой проект после неудачного первого шага — мусор в списке
        // пользователя; убираем сразу, не дожидаясь, пока он сам его
        // найдёт и удалит.
        await deleteProject(projectId).catch(() => undefined);
      }
      setSubmitting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !countryCode) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject({
        type,
        title: title.trim(),
        countryCode,
        ...(brandManifestId ? { brandManifestId } : {}),
      });
      navigate(routes.project(project.id), true);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.projectCreateScreen.title}
        back={routes.projects()}
        hint={dict.projectCreateScreen.hint}
      />

      {countries.error && !countries.loading ? (
        <LoadError error={countries.error} onRetry={countries.reload} />
      ) : (
        <Card className="p-5">
          <form onSubmit={submit} className="space-y-5">
            <div>
              <span className="label">
                {dict.projectCreateScreen.typeLabel}
              </span>
              <Pills
                value={type}
                onChange={setType}
                disabled={submitting}
                options={[
                  {
                    value: 'SINGLE',
                    label: (
                      <span className="inline-flex items-center gap-1">
                        <Package size={12} />{' '}
                        {dict.projectCreateScreen.singleLabel}
                      </span>
                    ),
                    sub: dict.projectCreateScreen.singleSub,
                  },
                  {
                    value: 'LINE',
                    label: (
                      <span className="inline-flex items-center gap-1">
                        <Layers size={12} />{' '}
                        {dict.projectCreateScreen.lineLabel}
                      </span>
                    ),
                    sub: dict.projectCreateScreen.lineSub,
                  },
                  {
                    value: 'CLIENT_SITE',
                    label: (
                      <span className="inline-flex items-center gap-1">
                        <Globe size={12} />{' '}
                        {dict.projectCreateScreen.clientSiteLabel}
                      </span>
                    ),
                    sub: dict.projectCreateScreen.clientSiteSub,
                  },
                  {
                    value: 'GREETING_VIDEO',
                    label: (
                      <span className="inline-flex items-center gap-1">
                        <Gift size={12} />{' '}
                        {dict.projectCreateScreen.greetingVideoLabel}
                      </span>
                    ),
                    sub: dict.projectCreateScreen.greetingVideoSub,
                  },
                ]}
              />
            </div>

            {/*
              Форма для «сайта заказчика» — не третий вариант в той же
              форме, а другая форма: название товара до того, как
              страница исследована, взять неоткуда, а страна для этого
              типа проекта ничего не считает (§4.2).
            */}
            {type === 'CLIENT_SITE' && (
              <div className="space-y-5">
                <Field
                  label={dict.clientSiteWizard.urlLabel}
                  htmlFor="client-site-url"
                  hint={dict.clientSiteWizard.urlHint}
                >
                  <Input
                    id="client-site-url"
                    type="url"
                    inputMode="url"
                    value={siteUrl}
                    onChange={(e) => setSiteUrl(e.target.value)}
                    placeholder="https://cabinet.example.com"
                    disabled={submitting}
                    autoFocus
                  />
                </Field>
                <Alert tone="info">{dict.clientSiteWizard.ownSiteOnly}</Alert>
                {error && <Alert tone="error">{error}</Alert>}
                <Button
                  block
                  size="lg"
                  type="button"
                  icon={<Search size={16} />}
                  disabled={submitting || siteUrl.trim().length === 0}
                  loading={submitting}
                  onClick={(e) => void submitSite(e)}
                >
                  {dict.clientSiteWizard.exploreButton}
                </Button>
              </div>
            )}

            {/*
              GREETING_VIDEO — своя форма, не третий/четвёртый вариант в
              общей: название собирается автоматически из повода и
              получателя (в отличие от SINGLE/LINE, спрашивать его тут
              незачем), а ведущий/качество/референсы/готовый текст
              поздравления — на следующем экране (GreetingVideoWizard),
              тем же приёмом, что у CLIENT_SITE.
            */}
            {type === 'GREETING_VIDEO' && (
              <div className="space-y-5">
                <Field label={dict.greetingVideoWizard.occasionLabel}>
                  <Select
                    value={occasion}
                    onChange={(e) =>
                      handleOccasionChange(e.target.value as GreetingOccasion)
                    }
                    disabled={submitting}
                  >
                    {GREETING_OCCASIONS.map((o) => (
                      <option key={o} value={o}>
                        {dict.greetingVideoWizard.occasion[o]}
                      </option>
                    ))}
                  </Select>
                </Field>

                {occasion === 'OTHER' && (
                  <Field
                    label={dict.greetingVideoWizard.customOccasionLabel}
                    htmlFor="greeting-custom-occasion"
                  >
                    <Input
                      id="greeting-custom-occasion"
                      value={customOccasionText}
                      onChange={(e) =>
                        setCustomOccasionText(e.target.value.slice(0, 120))
                      }
                      placeholder={
                        dict.greetingVideoWizard.customOccasionPlaceholder
                      }
                      disabled={submitting}
                    />
                  </Field>
                )}

                <Field
                  label={dict.greetingVideoWizard.recipientNameLabel}
                  htmlFor="greeting-recipient"
                >
                  <Input
                    id="greeting-recipient"
                    value={recipientName}
                    onChange={(e) =>
                      setRecipientName(e.target.value.slice(0, 120))
                    }
                    placeholder={
                      dict.greetingVideoWizard.recipientNamePlaceholder
                    }
                    disabled={submitting}
                    autoFocus
                  />
                </Field>

                <Field
                  label={dict.greetingVideoWizard.senderNameLabel}
                  htmlFor="greeting-sender"
                >
                  <Input
                    id="greeting-sender"
                    value={senderName}
                    onChange={(e) =>
                      setSenderName(e.target.value.slice(0, 120))
                    }
                    placeholder={dict.greetingVideoWizard.senderNamePlaceholder}
                    disabled={submitting}
                  />
                </Field>

                <div>
                  <span className="label">
                    {dict.greetingVideoWizard.toneLabel}
                  </span>
                  <Pills
                    value={tone}
                    onChange={setTone}
                    disabled={submitting}
                    options={allowedTonesFor(occasion).map((t) => ({
                      value: t,
                      label: dict.greetingVideoWizard.tone[t],
                    }))}
                  />
                </div>

                <Field
                  label={dict.greetingVideoWizard.personalMessageLabel}
                  htmlFor="greeting-message"
                  hint={dict.greetingVideoWizard.personalMessageHint}
                  counter={`${personalMessage.length}/2000`}
                >
                  <Textarea
                    id="greeting-message"
                    rows={3}
                    value={personalMessage}
                    onChange={(e) =>
                      setPersonalMessage(e.target.value.slice(0, 2000))
                    }
                    placeholder={
                      dict.greetingVideoWizard.personalMessagePlaceholder
                    }
                    disabled={submitting}
                  />
                </Field>

                <Field
                  label={dict.projectCreateScreen.countryLabel}
                  hint={
                    selectedCountry
                      ? dict.projectCreateScreen.countryHintSelected.replace(
                          '{{currency}}',
                          selectedCountry.currency
                        )
                      : undefined
                  }
                >
                  <CountryPicker
                    countries={countries.data ?? []}
                    value={countryCode}
                    onChange={setCountryCode}
                    disabled={submitting || countries.loading}
                  />
                </Field>

                <Field
                  label={dict.greetingVideoWizard.manifestLabel}
                  htmlFor="greeting-manifest"
                >
                  <Select
                    id="greeting-manifest"
                    value={brandManifestId}
                    onChange={(e) => setBrandManifestId(e.target.value)}
                    disabled={
                      submitting ||
                      !manifests.data ||
                      manifests.data.length === 0
                    }
                  >
                    <option value="">
                      {dict.greetingVideoWizard.noManifestOption}
                    </option>
                    {manifests.data?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                      </option>
                    ))}
                  </Select>
                </Field>

                {error && <Alert tone="error">{error}</Alert>}

                <Button
                  block
                  size="lg"
                  type="button"
                  icon={<Gift size={16} />}
                  disabled={!canSubmitGreeting}
                  loading={submitting}
                  onClick={(e) => void submitGreeting(e)}
                >
                  {dict.greetingVideoWizard.submitButton}
                </Button>
              </div>
            )}

            {type !== 'CLIENT_SITE' && type !== 'GREETING_VIDEO' && (
              <>
                <Field
                  label={dict.projectCreateScreen.titleLabel}
                  htmlFor="project-title"
                  hint={
                    type === 'LINE'
                      ? dict.projectCreateScreen.titleHintLine
                      : undefined
                  }
                  counter={`${title.length}/120`}
                >
                  <Input
                    id="project-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value.slice(0, 120))}
                    placeholder={
                      type === 'LINE'
                        ? dict.projectCreateScreen.titlePlaceholderLine
                        : dict.projectCreateScreen.titlePlaceholderSingle
                    }
                    disabled={submitting}
                    autoFocus
                  />
                </Field>

                <Field
                  label={dict.projectCreateScreen.countryLabel}
                  hint={
                    selectedCountry
                      ? dict.projectCreateScreen.countryHintSelected.replace(
                          '{{currency}}',
                          selectedCountry.currency
                        )
                      : dict.projectCreateScreen.countryHintDefault
                  }
                >
                  <CountryPicker
                    countries={countries.data ?? []}
                    value={countryCode}
                    onChange={setCountryCode}
                    disabled={submitting || countries.loading}
                  />
                </Field>

                <Field
                  label={dict.projectCreateScreen.manifestLabel}
                  htmlFor="project-manifest"
                  hint={
                    manifests.data && manifests.data.length === 0 ? (
                      <>
                        {dict.projectCreateScreen.manifestHintEmptyPrefix}
                        <button
                          type="button"
                          className="underline hover:text-accent"
                          onClick={() => navigate(routes.manifestNew())}
                        >
                          {dict.projectCreateScreen.manifestHintCreateLink}
                        </button>
                        {dict.projectCreateScreen.manifestHintEmptySuffix}
                      </>
                    ) : (
                      dict.projectCreateScreen.manifestHintDefault
                    )
                  }
                >
                  <Select
                    id="project-manifest"
                    value={brandManifestId}
                    onChange={(e) => setBrandManifestId(e.target.value)}
                    disabled={
                      submitting ||
                      !manifests.data ||
                      manifests.data.length === 0
                    }
                  >
                    <option value="">
                      {dict.projectCreateScreen.noManifestOption}
                    </option>
                    {manifests.data?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                      </option>
                    ))}
                  </Select>
                </Field>

                {error && <Alert tone="error">{error}</Alert>}

                <Button
                  block
                  size="lg"
                  type="submit"
                  disabled={!canSubmit}
                  loading={submitting}
                >
                  {dict.projectCreateScreen.submitButton}
                </Button>
              </>
            )}
          </form>
        </Card>
      )}
    </div>
  );
}
