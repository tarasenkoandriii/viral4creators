/**
 * Экран 1 — Создание проекта (spec §4): type toggle, searchable country
 * (currency derived), title, optional Brand Manifest (§12).
 */

import { useState } from 'react';
import { Globe, Layers, Package, Search } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Pills,
  Select,
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
import type { ProjectType } from '../../types/project';
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

            {type !== 'CLIENT_SITE' && (
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
