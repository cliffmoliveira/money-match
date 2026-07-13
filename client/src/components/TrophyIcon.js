import React from 'react';

// Filled with currentColor so it always exactly matches whatever gold text
// it sits next to, unlike an emoji glyph (fixed baked-in colors, can only be
// approximated with CSS filters).
const TrophyIcon = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M17 4V2H7v2H2v3c0 2.76 2.24 5 5 5h.17c.5 2.34 2.32 4.16 4.66 4.62V21H8v2h8v-2h-3.83v-2.38c2.34-.46 4.16-2.28 4.66-4.62H17c2.76 0 5-2.24 5-5V4h-5zM4 7V6h3v3.82C5.16 9.4 4 8.3 4 7zm16 0c0 1.3-1.16 2.4-3 2.82V6h3v1z" />
  </svg>
);

export default TrophyIcon;
