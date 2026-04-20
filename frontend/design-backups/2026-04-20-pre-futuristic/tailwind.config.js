/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#FF0000',
        'primary-hover': '#CC0000',
        'primary-light': '#FFEBEE',
        'bg-primary': '#FFFFFF',
        'bg-secondary': '#F9F9F9',
        'bg-tertiary': '#F1F1F1',
        'text-primary': '#0F0F0F',
        'text-secondary': '#606060',
        'text-tertiary': '#909090',
        'border-color': '#E5E5E5',
        'border-focus': '#FF0000',
        success: '#2E7D32',
        warning: '#ED6C02',
        error: '#D32F2F',
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans JP', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06)',
        'card-hover': '0 4px 6px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.06)',
      },
    },
  },
  plugins: [],
}
