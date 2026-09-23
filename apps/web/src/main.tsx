import { createRoot } from 'react-dom/client';
import EktSite from './EktSite';
import { mountAssistant } from './assistant/mount';
import './styles.css';

createRoot(document.getElementById('root')!).render(<EktSite />);
mountAssistant();
