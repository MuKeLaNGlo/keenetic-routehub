use crate::ParseResult;

pub(crate) struct CsvRows<'a> {
    remaining: &'a str,
    delimiter: char,
    comments: bool,
    line_number: usize,
}

impl<'a> CsvRows<'a> {
    pub(crate) fn new(data: &'a str, delimiter: char, comments: bool) -> Self {
        Self {
            remaining: data,
            delimiter,
            comments,
            line_number: 0,
        }
    }

    fn physical_line(&mut self) -> Option<(&'a str, bool)> {
        if self.remaining.is_empty() {
            return None;
        }
        self.line_number += 1;
        let text = self.remaining;
        let (line, rest) = text.split_once('\n').unwrap_or((text, ""));
        self.remaining = rest;
        let newline = line.len() < text.len();
        Some((line.strip_suffix('\r').unwrap_or(line), newline))
    }

    pub(crate) fn next_row(&mut self) -> ParseResult<Option<(usize, Vec<String>)>> {
        let (mut line, mut newline) = loop {
            let Some((line, newline)) = self.physical_line() else {
                return Ok(None);
            };
            if !line.is_empty() && !(self.comments && line.starts_with('#')) {
                break (line, newline);
            }
        };
        let start_line = self.line_number;
        let mut row = Vec::new();
        let mut column = 1;

        'row: loop {
            let trimmed = line.trim_start();
            column += line.len() - trimmed.len();
            line = trimmed;
            if let Some(tail) = line.strip_prefix('"') {
                line = tail;
                column += 1;
                let mut quoted = String::new();
                loop {
                    if let Some((field, after)) = line.split_once('"') {
                        quoted.push_str(field);
                        column += field.len();
                        match after.chars().next() {
                            Some('"') => {
                                quoted.push('"');
                                line = &after[1..];
                                column += 2;
                            }
                            Some(ch) if ch == self.delimiter => {
                                row.push(quoted);
                                line = &after[ch.len_utf8()..];
                                column += 1 + ch.len_utf8();
                                continue 'row;
                            }
                            None => {
                                row.push(quoted);
                                break 'row;
                            }
                            _ => return Err(self.quote_error(start_line, column, false)),
                        }
                    } else {
                        quoted.push_str(line);
                        column += line.len() + usize::from(newline);
                        if newline {
                            quoted.push('\n');
                        }
                        let Some((next, has_newline)) = self.physical_line() else {
                            return Err(self.quote_error(start_line, column, false));
                        };
                        line = next;
                        newline = has_newline;
                        column = 1;
                    }
                }
            }
            let (first, rest) = match line.split_once(self.delimiter) {
                Some((first, rest)) => (first, Some(rest)),
                None => (line, None),
            };
            if let Some(index) = first.find('"') {
                return Err(self.quote_error(start_line, column + index, true));
            }
            row.push(first.to_owned());
            let Some(rest) = rest else {
                break 'row;
            };
            column += first.len() + self.delimiter.len_utf8();
            line = rest;
        }
        Ok(Some((start_line, row)))
    }

    fn quote_error(&self, start: usize, column: usize, bare: bool) -> String {
        let error = if bare {
            "bare \" in non-quoted-field"
        } else {
            "extraneous or missing \" in quoted-field"
        };
        if start == self.line_number {
            format!("parse error on line {start}, column {column}: {error}")
        } else {
            format!(
                "record on line {start}; parse error on line {}, column {column}: {error}",
                self.line_number
            )
        }
    }
}
