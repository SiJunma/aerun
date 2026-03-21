import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pagesDir = path.join(__dirname, 'src', 'pages');

const pagesToRefactor = [
  'AdminPage.jsx',
  'TopicPage.jsx',
  'CategoryPage.jsx',
  'NotificationsPage.jsx',
  'ProfilePage.jsx'
];

pagesToRefactor.forEach(page => {
  const filePath = path.join(pagesDir, page);
  if (!fs.existsSync(filePath)) {
    console.error(`Not found: ${filePath}`);
    return;
  }

  let code = fs.readFileSync(filePath, 'utf8');

  // 1. Add import if not present
  if (!code.includes('useToast')) {
    // Add it after the last import
    const importRegex = /import .+ from '.+';\n/g;
    let match;
    let lastIndex = 0;
    while ((match = importRegex.exec(code)) !== null) {
      lastIndex = match.index + match[0].length;
    }
    code = code.slice(0, lastIndex) + "import { useToast } from '../contexts/ToastProvider';\n" + code.slice(lastIndex);
  }

  // 2. Remove Toast, ToastContainer from react-bootstrap imports if they exist
  code = code.replace(/Toast,\s*ToastContainer,?\s*/g, '');
  code = code.replace(/ToastContainer,\s*Toast,?\s*/g, '');
  code = code.replace(/Toast,?/g, '');
  code = code.replace(/ToastContainer,?/g, '');

  // 3. Replace useState for toast
  code = code.replace(/const \[toast, setToast\] = useState\(\{ show: false, message: '', variant: '.*?' \}\);\n?/g, 'const { showToast } = useToast();\n');
  code = code.replace(/const \[toast, setToast\] = useState\(\{ show: false, message: '' \}\);\n?/g, 'const { showToast } = useToast();\n');

  // 4. Replace setToast occurrences
  // setToast({ show: true, message: t('...'), variant: 'success' }) -> showToast(t('...'), 'success')
  code = code.replace(/setToast\(\{\s*show:\s*true,\s*message:\s*(.+?),\s*variant:\s*'(.+?)'\s*\}\)/g, "showToast($1, '$2')");
  // setToast({ show: true, message: '...', variant: 'danger' }) -> showToast('...', 'danger')
  code = code.replace(/setToast\(\{\s*show:\s*true,\s*message:\s*(.+?)\s*\}\)/g, "showToast($1, 'success')");

  // Remove the manual dismisses if any are left-over
  code = code.replace(/setToast\(\{ \.\.\.toast, show: false \}\)/g, ""); 
  code = code.replace(/setToast\(\t => \(\{ \.\.\.t, show: false \}\)\)/g, "");

  // 5. Remove the `<ToastContainer ...> ... </ToastContainer>` block
  const toastContainerRegex = /<ToastContainer[\s\S]*?<\/ToastContainer>/g;
  code = code.replace(toastContainerRegex, '');

  fs.writeFileSync(filePath, code, 'utf8');
  console.log(`Refactored ${page}`);
});
