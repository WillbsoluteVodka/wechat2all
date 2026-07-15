import { useEffect, useState } from "react";

import { HOME_INTRO_COPY } from "./constants";

export function HomeIntroCopy() {
  const [step, setStep] = useState(0);
  const copy = HOME_INTRO_COPY[step % HOME_INTRO_COPY.length] ?? HOME_INTRO_COPY[0]!;
  const className = step === 0 ? "home-intro-copy" : "home-intro-copy is-glitching";

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => current + 1);
    }, 4200);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <p
      className={className}
      data-text={copy.text}
      key={`${copy.lang}-${step}`}
      lang={copy.lang}
    >
      {copy.text}
    </p>
  );
}
