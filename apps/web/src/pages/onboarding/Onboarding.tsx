import { useLingui } from "@lingui/react/macro";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AccountMenu } from "../../components/account/AccountMenu";
import { SignupSurvey } from "../../components/account/SignupSurvey";
import { PageLoading } from "../../components/PageLoading";
import { useSignOut } from "../../lib/auth/sign-out";
import type { ModelCatalogEntry } from "../../lib/models/model-auth";
import { rpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import { FirstBotRetry } from "./first-bot";
import { KeyStep } from "./key-step";
import { ModelStep } from "./model-step";
import { useOnboardingModel } from "./use-onboarding-model";

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const fieldId = useId();
  // The URL holds the survey and model steps, so /onboarding/survey and /onboarding/model open directly.
  // The key step does not: it is offered again, or not, each time onboarding loads.
  const { step: routeStep } = useParams();
  const linkedStep = routeStep === "survey" || routeStep === "model" ? routeStep : undefined;
  const [creatingBot, setCreatingBot] = useState(false);
  const [surveyDone, setSurveyDone] = useState(false);
  const [keyOffered, setKeyOffered] = useState(false);
  const step = creatingBot
    ? "bot"
    : surveyDone
      ? "loading"
      : keyOffered
        ? "key"
        : (linkedStep ?? "loading");
  const [billingEnabled, setBillingEnabled] = useState(false);
  // The step after the survey, and after the key; null until me loads.
  const [afterSurvey, setAfterSurvey] = useState<"model" | "bot" | null>(null);
  const [afterKey, setAfterKey] = useState<"survey" | "model" | "bot" | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const model = useOnboardingModel({
    catalog,
    billingEnabled,
    onConnected: () => goTo("bot"),
  });
  const { error, modelProbe, setError } = model;
  const createStartedRef = useRef(false);
  const { signingOut, logOut } = useSignOut("/sign-in", setError);

  useEffect(() => {
    const leaving = new AbortController();
    const { signal } = leaving;
    void Promise.all([
      rpc.me(undefined, { signal }),
      rpc.models.list(undefined, { signal }).catch(() => []),
    ])
      .then(async ([me, models]) => {
        if (signal.aborted) return;
        setBillingEnabled(me.billingEnabled);
        setCatalog(models);
        const next = me.needsModel ? "model" : "bot";
        const first = me.needsSignupSurvey ? "survey" : next;
        setAfterSurvey(next);
        setAfterKey(first);
        // Asked before anything else, while nothing is recorded yet. Not being able to ask is
        // not a reason to hold up onboarding.
        const offered = me.recordLedgerEnabled
          ? (
              await bestEffort(
                "ask whether a backup key is offered",
                rpc.recordLedger.offer(undefined, { signal }),
              )
            )?.offer === true
          : false;
        if (signal.aborted) return;
        if (!linkedStep) goTo(offered ? "key" : first);
      })
      .catch(() => {
        if (signal.aborted) return;
        setAfterSurvey("bot");
        if (!linkedStep) goTo("bot");
      });
    return () => {
      leaving.abort();
      modelProbe.invalidate();
    };
  }, []);

  useEffect(() => {
    if (!surveyDone || !afterSurvey) return;
    setSurveyDone(false);
    goTo(afterSurvey);
  }, [surveyDone, afterSurvey]);

  function goTo(next: "key" | "survey" | "model" | "bot") {
    if (next === "bot") setCreatingBot(true);
    setKeyOffered(next === "key");
    navigate(next === "bot" ? "/onboarding" : `/onboarding/${next}`, { replace: true });
  }

  async function createFirstBot() {
    if (createStartedRef.current) return;
    createStartedRef.current = true;
    setError(null);
    try {
      // The server creates and greets Chief only in a Space that never held a chat; otherwise
      // the app shows the Space as it is.
      const { botId } = await rpc.onboarding.firstBot();
      navigate(botId ? `/app/${botId}` : "/app");
    } catch (err) {
      createStartedRef.current = false;
      setError(errorText(err, t`Could not create your bot`));
    }
  }

  useEffect(() => {
    if (step !== "bot") return;
    void createFirstBot();
  }, [step]);

  // Loading, and creating the first bot, both wait on one spinner until the chat opens.
  if (step === "loading" || (step === "bot" && !error)) return <PageLoading />;

  return (
    <div className="min-h-full bg-background px-6 py-12" data-rakazo-surface="onboarding">
      <AccountMenu signingOut={signingOut} onLogOut={() => void logOut()} />
      <div className="mx-auto w-full max-w-[560px]">
        {step === "key" ? <KeyStep onDone={() => goTo(afterKey ?? "bot")} /> : null}
        {step === "survey" ? <SignupSurvey onDone={() => setSurveyDone(true)} /> : null}
        {step === "model" ? <ModelStep model={model} fieldId={fieldId} /> : null}
        {step === "bot" ? (
          <FirstBotRetry error={error} onRetry={() => void createFirstBot()} />
        ) : null}
      </div>
    </div>
  );
}
