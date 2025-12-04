# Gerber to LightBurn Converter

Aplikacja webowa służąca do konwersji plików Gerber (PCB) na format SVG, zoptymalizowany pod kątem importu do oprogramowania LightBurn (do laserowego naświetlania/wypalania płytek PCB).

## Funkcjonalności

*   **Podgląd plików Gerber i Drill:** Obsługa formatów RS-274X oraz Excellon.
*   **Automatyczne rozpoznawanie warstw:** Inteligentne przypisywanie kolorów i kolejności warstw (Miedź, Soldermaska, Opisy, Otwory, Obrys).
*   **Tryb Inverted (Negatyw):** Automatyczne generowanie negatywu dla warstw miedzi (niezbędne do fotochemicznej metody produkcji PCB lub ablacji laserowej).
*   **Eksport do SVG:** Generowanie plików SVG gotowych do użycia w LightBurn.
    *   Poprawne łączenie ścieżek (Union) za pomocą biblioteki ClipperLib.
    *   Obsługa obrysów (Profile/Outline) jako linii cięcia (stroke) zamiast wypełnienia.
    *   Możliwość lustrzanego odbicia (Mirror) dla dolnej warstwy.
*   **Interfejs:**
    *   Przeciągnij i upuść (Drag & Drop).
    *   Przybliżanie i przesuwanie widoku (Pan & Zoom).
    *   Zarządzanie widocznością i przezroczystością warstw.

## Technologie

*   React 19
*   Vite
*   Paper.js (wstępne przetwarzanie geometrii)
*   ClipperLib (operacje boolowskie na ścieżkach)
*   Tailwind CSS (stylowanie)

## Uruchomienie projektu

1.  Instalacja zależności:
    ```bash
    npm install
    ```

2.  Uruchomienie serwera deweloperskiego:
    ```bash
    npm run dev
    ```

3.  Budowanie wersji produkcyjnej:
    ```bash
    npm run build
    ```

4.  Deploy na GitHub Pages:
    ```bash
    npm run deploy
    ```

## Autor

**Sagan** (2025)
