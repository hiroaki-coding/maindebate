/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#00AEEF',
        'primary-hover': '#008EC2',
        'primary-light': '#DDF5FF',
        'bg-primary': '#F5FAFF',
        'bg-secondary': '#EAF3FF',
        'bg-tertiary': '#D5E7FF',
        'text-primary': '#04132A',
        'text-secondary': '#3B4D69',
        'text-tertiary': '#6A7D9F',
        'border-color': '#B6CCE8',
        'border-focus': '#00AEEF',
        success: '#15A373',
        warning: '#F59E0B',
        error: '#E11D48',
      },
      fontFamily: {
        sans: ['Rajdhani', 'Noto Sans JP', 'sans-serif'],
        display: ['Orbitron', 'Rajdhani', 'Noto Sans JP', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 12px 35px rgba(7, 28, 68, 0.14)',
        'card-hover': '0 16px 44px rgba(7, 28, 68, 0.2)',
      },
    },
  },
  plugins: [],
}
