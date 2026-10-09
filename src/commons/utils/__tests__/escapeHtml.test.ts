import { escapeHtml } from '../escapeHtml';

describe('escapeHtml', () => {
  it('neutralise une balise injectée', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('empêche de sortir d\'un attribut entre guillemets', () => {
    expect(escapeHtml('" onclick="x\'')).toBe('&quot; onclick=&quot;x&#39;');
  });

  it('échappe l\'esperluette en premier, sans double échappement', () => {
    expect(escapeHtml('A&B &lt;')).toBe('A&amp;B &amp;lt;');
  });

  it('laisse inchangé un texte ordinaire accentué', () => {
    expect(escapeHtml('Photocard Jungkook — édition limitée')).toBe('Photocard Jungkook — édition limitée');
  });
});
