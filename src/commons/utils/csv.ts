import { Response } from 'express';

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

const UTF8_BOM = '﻿';

export const CSV_EXPORT_ROW_LIMIT = 5000;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

const formatCell = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  const value = raw instanceof Date ? raw.toISOString() : String(raw);
  const safe = FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix))
    ? `'${value}`
    : value;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const toCsv = <T>(rows: T[], columns: CsvColumn<T>[]): string => {
  const header = columns.map((column) => formatCell(column.header)).join(',');
  const body = rows.map((row) =>
    columns.map((column) => formatCell(column.value(row))).join(',')
  );
  return [header, ...body].join('\r\n');
};

export const wantsCsv = (format: unknown): boolean => format === 'csv';

/** Fichier CSV prêt à télécharger : produit par les services, envoyé par les contrôleurs. */
export interface CsvFile {
  fileName: string;
  content: string;
}

/** Construit le fichier daté `<baseName>-AAAA-MM-JJ.csv` (BOM UTF-8 pour Excel). */
export const buildCsvFile = <T>(baseName: string, rows: T[], columns: CsvColumn<T>[]): CsvFile => {
  const stamp = new Date().toISOString().slice(0, 10);
  return { fileName: `${baseName}-${stamp}.csv`, content: UTF8_BOM + toCsv(rows, columns) };
};

export const sendCsvFile = (res: Response, file: CsvFile): Response =>
  res
    .status(200)
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`)
    .send(file.content);

/** @deprecated Préférer `buildCsvFile` (service) + `sendCsvFile` (contrôleur). */
export const sendCsvDownload = <T>(
  res: Response,
  fileName: string,
  rows: T[],
  columns: CsvColumn<T>[]
): Response => sendCsvFile(res, buildCsvFile(fileName, rows, columns));
