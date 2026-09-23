import { createRoot } from 'react-dom/client';
import { Assistant } from './Assistant';
import { configureApi } from '../api';
import type { Locale } from '../types';
import styles from './widget.css?inline';

export type WidgetOptions = { apiBase?: string; locale?: Locale };
let destroyWidget: (() => void) | undefined;
/** Isolated widget: host page styles and React never cross the Shadow DOM boundary. */
export function mountAssistant(options: WidgetOptions = {}) {
  if (destroyWidget) return destroyWidget;
  configureApi(options.apiBase);
  const host = document.createElement('div');
  host.id = 'ekt-ai-widget';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = styles;
  const container = document.createElement('div');
  shadow.append(style, container); document.body.append(host);
  const root = createRoot(container);
  root.render(<Assistant initialLocale={options.locale} />);
  destroyWidget = () => { root.unmount(); host.remove(); destroyWidget = undefined; };
  return destroyWidget;
}
