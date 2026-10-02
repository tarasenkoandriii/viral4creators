/**
 * `<AssistWidget siteKey=… position=… />` — T (Э3, §3-бис.2). Обёртка над
 * loadAssist в useEffect (SSR — ничего), рендерит null; размонтирование —
 * `destroy()`. React — необязательный peerDependency (типы — devDependency
 * сборки).
 */
import { useEffect } from "react";
import type * as React from "react";
import { loadAssist, type LoadAssistOptions } from "./index";

export type AssistWidgetProps = LoadAssistOptions;

export function AssistWidget(
  props: AssistWidgetProps,
): React.ReactElement | null {
  const {
    siteKey,
    origin,
    position,
    offsetX,
    offsetY,
    lang,
    mobile,
    launcher,
    container,
    zIndex,
    nonce,
  } = props;
  const hideOn = (props.hideOn ?? []).join(",");
  useEffect(() => {
    const api = loadAssist({
      siteKey,
      origin,
      position,
      offsetX,
      offsetY,
      lang,
      mobile,
      launcher,
      container,
      zIndex,
      nonce,
      hideOn: hideOn ? hideOn.split(",") : [],
    });
    return () => api.destroy();
  }, [
    siteKey,
    origin,
    position,
    offsetX,
    offsetY,
    lang,
    mobile,
    launcher,
    container,
    zIndex,
    nonce,
    hideOn,
  ]);
  return null;
}
