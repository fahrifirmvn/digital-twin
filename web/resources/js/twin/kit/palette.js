// Palet dunia 3D. Terang mengikuti scene V6; gelap diturunkan untuk mode gelap V7.
export const PALETTES = {
    light: {
        name: 'light', ground: '#EEF1FB', seam: '#E3E8F5', asphalt: '#CDD3E6', curb: '#F1F5F9', concrete: '#E2E8F0',
        road: '#6F788E', roadCurb: '#F8FAFC',
        labPave: '#E9E4FA', white: '#F8FAFC', blue: '#2F5BEA', paleBlue: '#BFD0FB', steel: '#E1E7F0',
        steelDark: '#C8D1DE', slate: '#334155', glass: '#1E293B', purple: '#7C3AED', amber: '#F59E0B',
        orange: '#F97316', tree: '#9AD9B3', rail: '#CBD5E1', lavGlass: '#E9E4FB', dome: '#E8EDF5',
        roofLine: '#3F6AF2', stripeBg: '#FDF0D2', stripe: '#F7C766', apronLine: '#EAF0F7', alert: '#DC2626',
        blob: '142,152,201', blobAlpha: 0.55, sun: '#FFF7ED', sunPower: 1.5, hemiSky: '#DDE3FB', hemiGround: '#EEF1FB', hemiPower: 2.3,
    },
    dark: {
        name: 'dark', ground: '#0B1220', seam: '#111A2E', asphalt: '#1E293B', curb: '#334155', concrete: '#202B3D',
        road: '#2F3B52', roadCurb: '#64748B',
        labPave: '#241F43', white: '#CBD5E1', blue: '#4C7BFF', paleBlue: '#3B4F8F', steel: '#64748B',
        steelDark: '#475569', slate: '#0F172A', glass: '#020617', purple: '#8B5CF6', amber: '#F59E0B',
        orange: '#FB923C', tree: '#2F6B4F', rail: '#475569', lavGlass: '#312E5A', dome: '#7C8AA0',
        roofLine: '#6D8DFF', stripeBg: '#3A2F14', stripe: '#8A6A1F', apronLine: '#33415A', alert: '#F87171',
        blob: '2,6,23', blobAlpha: 0.6, sun: '#C7D2FE', sunPower: 1.6, hemiSky: '#94A3B8', hemiGround: '#1E293B', hemiPower: 2.6,
    },
};

export const paletteOf = (name) => PALETTES[name] ?? PALETTES.light;
