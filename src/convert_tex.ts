import fs = require('fs')
import path = require('path')
import md2html = require('./convert_html')
import _ = require('lodash')
import Token = require('markdown-it/lib/token')
import patterns = require("./patterns")
import { texMathify, HtmlToTexPixelRatio, Dict, texEscapeChars, parseLanguageCodeFromTaskPath, readFileStrippingBom, texMath, TaskMetadata, siblingWithExtension } from './util'
import codes = require("./codes")
// import { numberToString } from 'pdf-lib'
import { isString, isUndefined } from 'lodash'

export async function convertTask_tex(taskFile: string, fileOut: string): Promise<string> {

    const langCode = parseLanguageCodeFromTaskPath(taskFile) ?? codes.defaultLanguageCode()
    const textMd = await readFileStrippingBom(taskFile)
    const [tokens, metadata] = md2html.parseMarkdown(textMd, path.dirname(taskFile), {
        langCode,
        // we use ⍀ to avoid escaping \ to \\, and we later convert it back to \
        customQuotes: ["⍀enquote⦃", "⦄", "⍀enquote⦃", "⦄"],
    })
    const linealizedTokens = _.flatMap(tokens, t => {
        if (t.type === "inline") {
            return t.children ?? []
        } else {
            return [t]
        }
    })

    // for (const t of linealizedTokens) {
    //     console.log(t)
    // }
    // console.log(metadata)


    const texDataStandalone = renderTex(linealizedTokens, langCode, metadata, taskFile, true)
    await fs.promises.writeFile(fileOut, texDataStandalone)
    console.log(`Output written on ${fileOut}`)


    const texDataBrochure = renderTex(linealizedTokens, langCode, metadata, taskFile, false)
    const fileOutBrochure = siblingWithExtension(fileOut, "_brochure.tex")
    await fs.promises.writeFile(fileOutBrochure, texDataBrochure)
    console.log(`Output written on ${fileOutBrochure}`)

    return fileOut
}

export function renderTex(linealizedTokens: Token[], langCode: string, metadata: TaskMetadata, filepath: string, standalone: boolean,): string {

    const license = patterns.genLicense(metadata)

    const skip = () => ""

    let _currentToken: Token
    let _currentSection: string = "prologue"

    function warn(msg: string) {
        console.log(`Warning: ${msg}`)
        console.log(`  while procesing following token:`)
        console.log(_currentToken)
    }

    type CellType = "thead" | "makecell" | "plain"

    function defaultRendererState() {
        return {
            isInHeading: false,
            currentTable: undefined as undefined | { cellAlignmentChars: Array<string>, closeWith: string },
            currentTableCell: undefined as undefined | { type: CellType, closeWith: string },
            currentTableRowIndex: -1,
            currentTableColumnIndex: -1,
            validMultirows: [] as Array<{ colIndex: number, rowIndex: number, rowspan: number }>,
            lastRowTypeInThisTable: undefined as undefined | "header" | "body",
            hasCellOnThisLine: false,
            closeSectionWith: "",
            disableMathify: false,
            noPageBreak: false,
        }
    }

    type RendererState = ReturnType<typeof defaultRendererState>

    class RendererEnv {
        private stateStack: Array<RendererState>

        constructor() {
            this.stateStack = [defaultRendererState()]
        }

        state(): Readonly<RendererState> {
            return this.stateStack[this.stateStack.length - 1]
        }

        setState(newPartialState: Partial<RendererState>): RendererState {
            const newState = { ...this.state(), ...newPartialState }
            this.stateStack[this.stateStack.length - 1] = newState
            return newState
        }

        pushState(newPartialState: Partial<RendererState>) {
            const newState = { ...this.state(), ...newPartialState }
            this.stateStack.push(newState)
        }

        popState(): RendererState {
            return this.stateStack.pop()!
        }
    }

    type Rules = { [key: string]: undefined | ((tokens: Token[], idx: number, env: RendererEnv) => string | { skipToNext: string }) }

    const sectionCommands: Array<[string, string]> = [
        ["\\section*{\\centering{} ", "}"],
        ["\\subsection*{", "}"],
        ["\\subsubsection*{", "}"],
        ["\\paragraph*{", "}"],
        ["\\subparagraph*{", "}"],
    ]

    const FormatBrochure = true

    const sectionRenderingData: Dict<{ skip: boolean, pre: string, post: string, disableMathify: boolean }> = {
        "Body": { skip: false, pre: "", post: "", disableMathify: false },
        "Question/Challenge": { skip: false, pre: "{\\em\n", post: "}", disableMathify: true },
        "Answer Options/Interactivity Description": { skip: false, pre: "", post: "", disableMathify: false },
        "Answer Explanation": { skip: false, pre: "", post: "", disableMathify: false },
        "It's Informatics": { skip: false, pre: "", post: "", disableMathify: false },
        "Keywords and Websites": { skip: false, pre: "{\\raggedright\n", post: "\n}", disableMathify: true },
        "Wording and Phrases": { skip: FormatBrochure, pre: "", post: "", disableMathify: true },
        "Comments": { skip: FormatBrochure, pre: "", post: "", disableMathify: true },
        "Contributors": { skip: FormatBrochure, pre: "", post: "", disableMathify: true },
        "Support Files": { skip: FormatBrochure, pre: "", post: "", disableMathify: true },
        "License": { skip: FormatBrochure, pre: "", post: "", disableMathify: true },
    }

    const skipHeader = FormatBrochure

    function sectionCommandsForHeadingToken(t: Token): [string, string] {
        const level = parseInt(t.tag.slice(1))
        const idx = Math.min(level - 1, sectionCommands.length - 1)
        return sectionCommands[idx]
    }


    const expand: Rules = {

        "header": (tokens, idx, env) => {
            if (skipHeader) {
                return ""
            }

            const ageCategories = patterns.ageCategories
            const categories = patterns.categories

            const ageCatTitles = (Object.keys(ageCategories) as Array<keyof typeof ageCategories>)
            const ageCatTitleCells = ageCatTitles.map(c => `\\textit{${c}:}`).join(" & ")

            const ageCatValueCells = ageCatTitles.map(c => {
                const catFieldName = ageCategories[c]
                const catValue: string = metadata.ages[catFieldName] || "--"
                return catValue
            }).join(" & ")

            const numCat1 = Math.floor(categories.length / 2)

            const checkedBox = `$\\boxtimes$`
            const uncheckedBox = `$\\square$`

            function catToRow(catName: string) {
                const isRelated = metadata.categories.includes(catName)
                const catChecked = isRelated ? checkedBox : uncheckedBox
                return `${catChecked} ${texEscapeChars(catName)}`
            }

            let catCell1 = `\\textit{Categories:}`
            for (let i = 0; i < numCat1; i++) {
                catCell1 += `\\newline ${catToRow(categories[i])}`
            }

            let catCell2 = ``
            for (let i = numCat1; i < categories.length; i++) {
                if (i !== numCat1) {
                    catCell2 += "\\newline "

                }
                catCell2 += catToRow(categories[i])
            }

            const keywordsCaption = `\\textit{Keywords: }`
            const keywords = metadata.keywords.map(kwLine => {
                const match = patterns.keyword.exec(kwLine)
                return match ? match.groups.keyword : kwLine
            })
            const keywordsStr = keywords.length === 0 ? "—" : keywords.map(texEscapeChars).join(", ")

            function multicolumn(n: number, contents: string): string {
                const spec = `{|>{\\hsize=\\dimexpr${n}\\hsize+${n + 1}\\tabcolsep+${n - 1}\\arrayrulewidth\\relax}X|}`
                return `\\multicolumn{${n}}${spec}{${contents}}`
            }

            return `
\\renewcommand{\\tabularxcolumn}[1]{>{}p{#1}}
{\\footnotesize\\begin{tabularx}{\\columnwidth}{ | *{6}{ >{\\centering\\arraybackslash}X | } }
  \\hline
  ${ageCatTitleCells} \\\\
  ${ageCatValueCells} \\\\
  \\hline
  ${multicolumn(6, `\\textit{Answer Type:} ${texEscapeChars(metadata.answer_type)}`)} \\\\
  \\hline
  ${multicolumn(3, catCell1)} &  ${multicolumn(3, catCell2)} \\\\
  \\hline
  ${multicolumn(6, `\\settowidth{\\hangindent}{${keywordsCaption}}${keywordsCaption}${keywordsStr}`)} \\\\
  \\hline
\\end{tabularx}}
\\renewcommand{\\tabularxcolumn}[1]{>{}m{#1}}\n`
        },


        "license_body": (tokens, idx, env) => {
            // https://tex.stackexchange.com/questions/5433/can-i-use-an-image-located-on-the-web-in-a-latex-document
            const licenseLogoPath = path.join(__dirname, "..", "static", "CC_by-sa.pdf")
            return `
 \\renewcommand{\\tabularxcolumn}[1]{>{}m{#1}}
 {\\begin{tabularx}{\\columnwidth}{ l X }
 \\makecell[c]{\\includegraphics{${licenseLogoPath}}} & \\scriptsize ${license.fullCopyright()} \\href{${license.url}}{${license.url}}
\\end{tabularx}}
\\renewcommand{\\tabularxcolumn}[1]{>{}m{#1}}\n`
        },

    }

    function roundTenth(x: number): number {
        return Math.round(x * 10) / 10
    }

    function closeLineIfNeeded(env: RendererEnv) {
        env.setState({ currentTableColumnIndex: -1 })
        const lastRowType = env.state().lastRowTypeInThisTable
        if (lastRowType) {
            env.setState({ lastRowTypeInThisTable: undefined })
            const lineIfNeeded = (lastRowType === "header") ? "\\midrule\n" : "" // \topstrut doesn't work if followed by \muticolumn...
            return ` \\\\ \n${lineIfNeeded}`
        }
        return ""
    }

    function nonExpandingAlignment(possiblyExpandingAlignment?: string): string {
        if (possiblyExpandingAlignment === "J") {
            return "l"
        } else if (isUndefined(possiblyExpandingAlignment)) {
            return "l"
        } else {
            return possiblyExpandingAlignment.toLowerCase()
        }
    }

    function openCellPushingState(type: CellType, token: Token, env: RendererEnv): string {
        let state = env.setState({ currentTableColumnIndex: env.state().currentTableColumnIndex + 1 })
        let colIndex = state.currentTableColumnIndex
        const rowIndex = state.currentTableRowIndex

        let sep = ""
        if (state.hasCellOnThisLine) {
            env.setState({ hasCellOnThisLine: false })
            sep = " & "
        }

        function isSpannedByMultirow(): boolean {
            for (const multirow of state.validMultirows) {
                if (colIndex === multirow.colIndex && rowIndex <= multirow.rowIndex + multirow.rowspan - 1) {
                    return true
                }
            }
            return false
        }
        while (isSpannedByMultirow()) {
            // add a blank cell
            sep += "& "
            colIndex++
            state = env.setState({ currentTableColumnIndex: colIndex })
        }

        const align = nonExpandingAlignment(state.currentTable?.cellAlignmentChars[colIndex])

        let disableMathify = false
        let open = "" // default open and close markup
        let close = ""
        if (type === "thead") {
            // second char 'b' means 'bottom vertical alignement', which
            // we should have for headers
            open = `{\\setstretch{1.0}\\thead[${align}b]{`
            close = `}}`
            disableMathify = true
        } else if (type === "makecell") {
            open = `\\makecell[${align}]{`
            close = `}`
        }

        const rowspanStr = token.attrGet("rowspan")
        let rowspan
        if (rowspanStr && (rowspan = parseInt(rowspanStr)) >= 2) {
            // multicolumn
            open = `\\multirow{${rowspan}}{*}{` + open
            close = close + `}`
            state.validMultirows.push({ colIndex, rowIndex, rowspan })
        }

        const colspanStr = token.attrGet("colspan")
        let colspan
        if (colspanStr && (colspan = parseInt(colspanStr)) >= 2) {
            // multicolumn
            open = `\\multicolumn{${colspan}}{c}{` + open
            close = close + `}`
        }

        env.pushState({ currentTableCell: { type, closeWith: close }, disableMathify })
        const debug = ""
        // const debug = `(${rowIndex},${colIndex})--`
        return sep + open + debug
    }

    function closeCellPoppingState(env: RendererEnv): string {
        const cellState = env.popState()
        env.setState({ hasCellOnThisLine: true })
        return cellState.currentTableCell?.closeWith ?? ""
    }

    function breakIfInTableCell(env: RendererEnv): string | undefined {
        const currentTableCell = env.state().currentTableCell
        if (currentTableCell) {
            if (currentTableCell.type === "plain") {
                return " \\newline "
            } else {
                return " \\\\ "
            }
        }
        return undefined
    }

    function isSurrounded(tokens: Array<Token>, idx: number, distance: number, item: string, itemClose?: string): boolean {
        let itemOpen
        if (isUndefined(itemClose)) {
            itemOpen = `${item}_open`
            itemClose = `${item}_close`
        } else {
            itemOpen = item
        }
        const surrounded = idx - distance >= 0 &&
            idx + distance < tokens.length &&
            tokens[idx - distance].type === itemOpen &&
            tokens[idx + distance].type === itemClose
        return surrounded
    }

    const rules: Rules = {

        "inline": (tokens, idx, env) => {
            warn("unexpected inline tokens, should have been lineralized")
            return ""
        },

        "bebras_html_expand": (tokens, idx, env) => {
            const t = tokens[idx]
            const rule = expand[t.meta]
            if (rule) {
                return rule(tokens, idx, env)
            } else {
                warn(`no rule to expand '${t.meta}'`)
                return ""
            }
        },

        "text": (tokens, idx, env) => {
            let text = tokens[idx].content
            text = texEscapeChars(text)
            const state = env.state()
            if (!state.isInHeading && !state.disableMathify) {
                text = texMathify(text)
            }
            return text
        },

        "image": (tokens, idx, env) => {
            const t = tokens[idx]

            const imgPathForHtml = t.attrGet("src")!
            let type = "graphics"
            if (imgPathForHtml.endsWith(".svg")) {
                type = "svg"
            }

            const imgPathIsAbsolute = imgPathForHtml.startsWith("/")
            const imgPath = imgPathIsAbsolute ? imgPathForHtml : "\\taskGraphicsFolder/" + imgPathForHtml

            let title = t.attrGet("title")
            let includeOpts = ""
            let placement = "unspecified"
            let width: string | undefined = undefined
            let match
            if (title && (match = patterns.imageOptions.exec(title))) {
                title = title.replace(patterns.imageOptions, "")
                let value
                if (value = match.groups.width_abs) {
                    const f = roundTenth(parseFloat(value) * HtmlToTexPixelRatio)
                    width = `${f}px`
                    includeOpts = `[width=${width}]`
                } else if (value = match.groups.width_rel) {
                    const f = roundTenth(parseFloat(value.slice(0, value.length - 1)) / 100)
                    width = `${f}\\linewidth`
                    includeOpts = `[width=${width}]`
                }
                if (value = match.groups.placement) {
                    placement = value
                }
            }

            const state = env.state()
            const includeCmd = `\\include${type}${includeOpts}{${imgPath}}`

            let before = ""
            let after = ""

            function useMakecell() {
                const colIndex = state.currentTableColumnIndex
                const align = nonExpandingAlignment(state.currentTable?.cellAlignmentChars[colIndex])
                before = `\\makecell[${align}]{`
                after = `}`
            }

            function useCenterEnv() {
                // before = `{\\centering%\\begin{center}\n`
                // after = `\n\\end{center}`
                before = `{\\centering%\n`
                after = `\\par}`
            }

            function useRaisebox(ignoreHeight: boolean) {
                const sizeopt = ignoreHeight ? "[0pt][0pt]" : ""
                before = `\\raisebox{-0.5ex}${sizeopt}{`
                after = `}`
            }

            const isInTable = !!state.currentTableCell
            if (placement === "unspecified" || isInTable) {
                if (isSurrounded(tokens, idx, 1, "paragraph")) {
                    if (isSurrounded(tokens, idx, 2, "td")) {
                        useMakecell()
                    } else if (!isInTable) {
                        useCenterEnv()
                    } else {
                        // inline in table cell
                        useRaisebox(false)
                    }
                } else if (isSurrounded(tokens, idx, 1, "td")) {
                    useMakecell()
                } else if (isSurrounded(tokens, idx, 1, "text", "text")) {
                    // inline in paragraph
                    let ignoreHeight = true
                    try {
                        // heuristic: if width is >= 30, then don't ignore
                        ignoreHeight = parseInt(width?.replace(/px/, "") ?? "0") < 30
                    } catch { }
                    useRaisebox(ignoreHeight)
                }

            } else {
                // left or right
                const placementSpec = placement[0].toUpperCase()
                if (width) {
                    before = `\\begin{wrapfigure}{${placementSpec}}{${width}}\n\\raisebox{-.46cm}[\\height-.92cm][-.46cm]{`
                    after = `}\n\\end{wrapfigure}`

                } else {
                    warn(`Undefined width for floating image '${imgPathForHtml}'`)
                }
            }

            return `${before}${includeCmd}${after}`
        },

        "raw": (tokens, idx, env) => {
            const t = tokens[idx]
            if (t.info === "tex") {
                return t.content
            } else {
                return ""
            }
        },


        "math_inline": (tokens, idx, env) => {
            // enclosing with { } preserves fix spacing
            return '${' + texMath(tokens[idx].content) + '}$'
        },

        "math_single": (tokens, idx, env) => {
            return '$' + tokens[idx].content + '$'
        },

        "math_block": (tokens, idx, env) => {
            return '$$' + texMath(tokens[idx].content) + '$$'
        },

        "math_block_eqno": (tokens, idx, env) => {
            return '$$' + texMath(tokens[idx].content) + '$$' // TODO add eqno?
        },


        "hardbreak": (tokens, idx, env) => {
            let value
            if (value = breakIfInTableCell(env)) {
                return value
            }
            return " \\\\\n"
        },

        "softbreak": (tokens, idx, env) => {
            let value
            if (value = breakIfInTableCell(env)) {
                return value
            }
            return "\n"
        },

        "heading_open": (tokens, idx, env) => {
            const cmd = sectionCommandsForHeadingToken(tokens[idx])[0]
            env.pushState({ isInHeading: true })
            return `\n${cmd}`
        },

        "heading_close": (tokens, idx, env) => {
            const cmd = sectionCommandsForHeadingToken(tokens[idx])[1]
            env.popState()
            return `${cmd}\n\n`
        },


        "paragraph_open": (tokens, idx, env) => {
            return ""
        },

        "paragraph_close": (tokens, idx, env) => {
            const state = env.state()
            let type
            if (state.currentTableCell) {
                // ignore
                return ""
            } else if (idx + 1 < tokens.length && (type = tokens[idx + 1].type).endsWith("_close") && type !== "secbody_close") {
                // ignore, too... // TODO have a system that ensures a certain number of max newlines?
                return ""
            } else if (state.noPageBreak) {
                return "\n\n\\nopagebreak\n\n"
            } else {
                return "\n\n"
            }
        },


        "bullet_list_open": (tokens, idx, env) => {
            return `\\begin{itemize}\n`
        },

        "bullet_list_close": (tokens, idx, env) => {
            // no \n prefix as list_item_close has already inserted it
            return "\\end{itemize}\n\n"
        },


        "ordered_list_open": (tokens, idx, env) => {
            return `\\begin{enumerate}\n`
        },

        "ordered_list_close": (tokens, idx, env) => {
            // no \n prefix as list_item_close has already inserted it
            return "\\end{enumerate}\n\n"
        },


        "list_item_open": (tokens, idx, env) => {
            return `  \\item `
        },

        "list_item_close": (tokens, idx, env) => {
            return "\n"
        },


        "em_open": (tokens, idx, env) => {
            return `\\emph{`
        },

        "em_close": (tokens, idx, env) => {
            return `}`
        },


        "strong_open": (tokens, idx, env) => {
            env.pushState({ disableMathify: true })
            return `\\textbf{`
        },

        "strong_close": (tokens, idx, env) => {
            env.popState()
            return `}`
        },


        "sup_open": (tokens, idx, env) => {
            return `\\textsuperscript{`
        },

        "sup_close": (tokens, idx, env) => {
            return `}`
        },


        "sub_open": (tokens, idx, env) => {
            return `\\textsubscript{`
        },

        "sub_close": (tokens, idx, env) => {
            return `}`
        },


        "link_open": (tokens, idx, env) => {
            const t = tokens[idx]
            return `\\href{${t.attrGet("href")!.replace(/%/g, "\\%").replace(/#/g, "\\#")}}{\\BrochureUrlText{`
        },

        "link_close": (tokens, idx, env) => {
            return `}}`
        },


        "table_open": (tokens, idx, env) => {
            const t = tokens[idx]

            interface TableMetaSep {
                aligns: Array<string>
                wraps: Array<boolean>
                map: [number, number]
            }
            interface TableMeta {
                sep: TableMetaSep
                cap: null | object
                tr: Array<Token>
            }

            function columnSpec(alignString: string, hresize: boolean): string {
                switch (alignString) {
                    case "":
                        // default is justified
                        return hresize ? "J" : "l"
                    case "left":
                        return hresize ? "L" : "l"
                    case "center":
                        return hresize ? "C" : "c"
                    case "right":
                        return hresize ? "R" : "r"
                    default:
                        warn(`Unknown table column alignment: '${alignString}'`)
                        return "l"
                }
            }

            const tableMeta: TableMeta = t.meta
            const ncols = tableMeta.sep.aligns.length
            const specs: Array<string> = []
            let hasAnyHResize = false
            for (let i = 0; i < ncols; i++) {
                const hresize = tableMeta.sep.wraps[i]
                if (hresize) {
                    hasAnyHResize = true
                }
                specs.push(columnSpec(tableMeta.sep.aligns[i], hresize))
            }

            const spec = "@{} " + specs.join(" ") + " @{}"
            const open = !hasAnyHResize ? `\\begin{tabular}{ ${spec} }\n` : `\\begin{tabularx}{\\columnwidth}{ ${spec} }\n`
            const close = !hasAnyHResize ? `\n\\end{tabular}\n\n` : `\n\\end{tabularx}\n\n`

            env.pushState({ currentTableRowIndex: -1, validMultirows: [], currentTable: { cellAlignmentChars: specs, closeWith: close } })

            return open
        },

        "table_close": (tokens, idx, env) => {
            const state = env.popState()
            return state.currentTable!.closeWith
        },

        "thead_open": skip,
        "thead_close": skip,
        "tbody_open": skip,
        "tbody_close": skip,


        "tr_open": (tokens, idx, env) => {
            const closeIfNeeded = closeLineIfNeeded(env)
            env.setState({ currentTableRowIndex: env.state().currentTableRowIndex + 1 })
            return closeIfNeeded + "  "
        },

        "tr_close": (tokens, idx, env) => {
            const lastRowInThisTable = (tokens[idx - 1].type === "th_close") ? "header" : "body"
            env.setState({ hasCellOnThisLine: false, lastRowTypeInThisTable: lastRowInThisTable })
            return ""
        },

        "th_open": (tokens, idx, env) => {
            return openCellPushingState("thead", tokens[idx], env)
        },

        "th_close": (tokens, idx, env) => {
            return closeCellPoppingState(env)
        },

        "td_open": (tokens, idx, env) => {
            let hasBreaks = false
            const itemsPreventingMakecell = ["table_open", "ordered_list_open", "bullet_list_open"]
            let hasItemPreventingMakecell = false
            for (let i = idx + 1; i < tokens.length; i++) {
                const type = tokens[i].type
                if (type === "td_close") {
                    break
                } else if (type === "softbreak" || type === "hardbreak") {
                    hasBreaks = true
                } else if (itemsPreventingMakecell.includes(type)) {
                    hasItemPreventingMakecell = true
                }
            }
            const cellType = (hasBreaks && !hasItemPreventingMakecell) ? "makecell" : "plain"
            return openCellPushingState(cellType, tokens[idx], env)
        },

        "td_close": (tokens, idx, env) => {
            return closeCellPoppingState(env)
        },


        "container_center_open": (tokens, idx, env) => {
            return `{\\centering%\n`
            // return `\\begin{center}\n`
        },

        "container_center_close": (tokens, idx, env) => {
            return `\\par}\n\n`
            // return `\n\\end{center}\n\n`
        },


        "container_clear_open": (tokens, idx, env) => {
            return `` // TODO: try to clear all figures
        },

        "container_clear_close": (tokens, idx, env) => {
            return ``
        },


        "container_indent_open": (tokens, idx, env) => {
            return `\\begin{adjustwidth}{1.5em}{0em}\n`
        },

        "container_indent_close": (tokens, idx, env) => {
            return `\n\\end{adjustwidth}\n\n`
        },


        "container_nobreak_open": (tokens, idx, env) => {
            env.pushState({ noPageBreak: true })
            return `\\begin{samepage}\n`
        },

        "container_nobreak_close": (tokens, idx, env) => {
            env.popState()
            return `\n\\end{samepage}\n\n`
        },


        "seccontainer_open": (tokens, idx, env) => {
            let secData = { skip: false, pre: "", post: "", disableMathify: false }

            const sectionName = tokens[idx].info
            const specificSecData = sectionRenderingData[sectionName]
            if (specificSecData) {
                secData = specificSecData
            }
            if (secData.skip) {
                return { skipToNext: "seccontainer_close" }
            } else {
                env.pushState({ closeSectionWith: secData.post, disableMathify: secData.disableMathify })
                return secData.pre
            }
        },

        "seccontainer_close": (tokens, idx, env) => {
            const state = env.popState()
            return state.closeSectionWith
        },

        "secbody_open": (tokens, idx, env) => {
            const sectionName = tokens[idx].info
            _currentSection = sectionName
            return ""
        },

        "secbody_close": (tokens, idx, env) => {
            _currentSection = "intersection_text"
            return ""
        },

        "main_open": skip,
        "main_close": skip,

        "tocOpen": skip,
        "tocBody": skip,
        "tocClose": skip,

    }

    const sectionStrs: Dict<Array<string>> = {}


    function traverse(tokens: Token[], env: RendererEnv): string {
        const parts = [] as string[]
        let r

        for (let idx = 0; idx < tokens.length; idx++) {
            _currentToken = tokens[idx]
            const rule = rules[_currentToken.type]
            if (rule) {
                if (r = rule(tokens, idx, env)) {
                    if (isString(r)) {
                        parts.push(r)
                        let secParts = sectionStrs[_currentSection]
                        if (isUndefined(secParts)) {
                            secParts = [r]
                            sectionStrs[_currentSection] = secParts
                        } else {
                            secParts.push(r)
                        }
                    } else {
                        const { skipToNext } = r
                        while (tokens[idx].type !== skipToNext) {
                            idx++
                            if (idx === tokens.length) {
                                break
                            }
                        }
                    }
                }
            } else {
                warn(`No renderer rule for ${_currentToken.type}`)
            }
        }
        return parts.join("")
    }

    const env = new RendererEnv()
    const taskTex = traverse(linealizedTokens, env)

    const babels: Dict<string> = {
        eng: `\\usepackage[english]{babel}`,
        deu: `\\usepackage[german]{babel}`,
        ita: `\\usepackage[italian]{babel}`,
        fra: `\\usepackage[french]{babel}
\\frenchbsetup{ThinColonSpace=true}
\\renewcommand*{\\FBguillspace}{\\hskip .4\\fontdimen2\\font plus .1\\fontdimen3\\font minus .3\\fontdimen4\\font \\relax}`,
    }

    const babel = babels[langCode] ?? babels.eng


    function difficultyIndex(ageCat: "6-8" | "8-10" | "10-12" | "12-14" | "14-16" | "16-19"): number {
        const diffStr = metadata.ages[ageCat]
        if (diffStr.startsWith("--")) {
            return 0
        }
        if (diffStr === "easy") {
            return 1
        }
        if (diffStr === "medium") {
            return 2
        }
        if (diffStr === "hard") {
            return 3
        }
        return 0
    }

    let countryCode = "??"
    let match
    if (match = patterns.id.exec(metadata.id)) {
        countryCode = match.groups.country_code
    }

    function asciify(name: string): string {
        // https://stackoverflow.com/questions/990904/remove-accents-diacritics-in-a-string-in-javascript
        return name
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .replace(/ł/g, "l")
            .replace(/[\-]/g, "")
    }

    function normalizeAuthorName(fullName: string): [string, string] {
        const parts = fullName.split(/ +/)
        if (parts.length === 1) {
            console.log(`WARNING: Cannot split full name '${fullName}'`)
            return [asciify(parts[0]), "A"]
        } else if (parts.length === 2) {
            return [asciify(parts[1]), asciify(parts[0][0]).toUpperCase()]
        } else {
            const split: [string, string] = [asciify(parts[parts.length - 1]), asciify(parts[0][0]).toUpperCase()]
            // console.log(`WARNING: Check split for full name '${fullName}': ${split}`)
            return split
        }
    }

    function authorDefs(): string {
        const authorLines: Array<string> = []
        metadata.contributors.forEach((contribLine) => {
            const match = patterns.contributor.exec(contribLine)
            if (match) {
                const name = match.groups.name
                const [lastname, firstnameInit] = normalizeAuthorName(name)
                const authorCmd = `\\Author${lastname}${firstnameInit}`
                const lowercaseCountryCode = codes.countryCodeByCountryName[match.groups.country]?.toLowerCase() ?? "aa"
                if (lowercaseCountryCode === "aa") {
                    console.log(`WARNING: unrecognized country '${match.groups.country}'`)
                }
                const texifiedName = name.replace(/\. /g, ".~")
                const define = `\\ifdefined${authorCmd} \\BrochureFlag{${lowercaseCountryCode}}{} ${texifiedName}\\fi`
                const marker = `\\def${authorCmd}{}`
                authorLines.push(`${marker} % ${define}`)
            }
        })
        return authorLines.join("\n")
    }

    function sectionTexFor(secName: string): string {
        return (sectionStrs[secName] ?? ["TODO"]).join("")
    }



    if (!standalone) {
        return `% Definition of the meta information: task difficulties, task ID, task title, task country; definition of the variables as well as their scope is in commands.tex
\\setcounter{taskAgeDifficulty3to4}{${difficultyIndex("8-10")}}
\\setcounter{taskAgeDifficulty5to6}{${difficultyIndex("10-12")}}
\\setcounter{taskAgeDifficulty7to8}{${difficultyIndex("12-14")}}
\\setcounter{taskAgeDifficulty9to10}{${difficultyIndex("14-16")}}
\\setcounter{taskAgeDifficulty11to13}{${difficultyIndex("16-19")}}
\\renewcommand{\\taskTitle}{${metadata.title}}
\\renewcommand{\\taskCountry}{${countryCode}}

% include this task only if for the age groups being processed this task is relevant
\\ifthenelse{
  \\(\\boolean{age3to4} \\AND \\(\\value{taskAgeDifficulty3to4} > 0\\)\\) \\OR
  \\(\\boolean{age5to6} \\AND \\(\\value{taskAgeDifficulty5to6} > 0\\)\\) \\OR
  \\(\\boolean{age7to8} \\AND \\(\\value{taskAgeDifficulty7to8} > 0\\)\\) \\OR
  \\(\\boolean{age9to10} \\AND \\(\\value{taskAgeDifficulty9to10} > 0\\)\\) \\OR
  \\(\\boolean{age11to13} \\AND \\(\\value{taskAgeDifficulty11to13} > 0\\)\\)}{

\\newchapter{\\taskTitle}

% task body
${sectionTexFor("Body")}

% question (as \\emph{})
{\\em
${sectionTexFor("Question/Challenge")}
}

% answer alternatives (as \\begin{enumerate}[A)]) or interactivity
${sectionTexFor("Answer Options/Interactivity Description")}

% from here on this is only included if solutions are processed
\\ifthenelse{\\boolean{solutions}}{
\\newpage

% answer explanation
\\section*{\\BrochureSolution}
${sectionTexFor("Answer Explanation")}

% it's informatics
\\section*{\\BrochureItsInformatics}
${sectionTexFor("It's Informatics")}

% keywords and websites (as \\begin{itemize})
\\section*{\\BrochureWebsitesAndKeywords}
{\\raggedright
${sectionTexFor("Keywords and Websites")}
}

% end of ifthen for excluding the solutions
}{}

% all authors
% ATTENTION: you HAVE to make sure an according entry is in ../main/authors.tex.
% Syntax: \\def\\AuthorLastnameF{} (Lastname is last name, F is first letter of first name, this serves as a marker for ../main/authors.tex)
${authorDefs()}

\\newpage}{}
`
    } else {
        return '' +
            `\\documentclass[a4paper,11pt]{report}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}

${babel}
\\AtBeginDocument{\\def\\labelitemi{$\\bullet$}}

\\usepackage{etoolbox}

\\usepackage[margin=2cm]{geometry}
\\usepackage{changepage}
\\makeatletter
\\renewenvironment{adjustwidth}[2]{%
    \\begin{list}{}{%
    \\partopsep\\z@%
    \\topsep\\z@%
    \\listparindent\\parindent%
    \\parsep\\parskip%
    \\@ifmtarg{#1}{\\setlength{\\leftmargin}{\\z@}}%
                 {\\setlength{\\leftmargin}{#1}}%
    \\@ifmtarg{#2}{\\setlength{\\rightmargin}{\\z@}}%
                 {\\setlength{\\rightmargin}{#2}}%
    }
    \\item[]}{\\end{list}}
\\makeatother

\\newcommand{\\BrochureUrlText}[1]{\\texttt{#1}}
\\usepackage{setspace}
\\setstretch{1.15}

\\usepackage{tabularx}
\\usepackage{booktabs}
\\usepackage{makecell}
\\usepackage{multirow}
\\renewcommand\\theadfont{\\bfseries}
\\renewcommand{\\tabularxcolumn}[1]{>{}m{#1}}
\\newcolumntype{R}{>{\\raggedleft\\arraybackslash}X}
\\newcolumntype{C}{>{\\centering\\arraybackslash}X}
\\newcolumntype{L}{>{\\raggedright\\arraybackslash}X}
\\newcolumntype{J}{>{\\arraybackslash}X}

\\usepackage{amssymb}

\\usepackage[babel=true,maxlevel=3]{csquotes}
\\DeclareQuoteStyle{bebras-ch-eng}{“}[” ]{”}{‘}[”’ ]{’}\
\\DeclareQuoteStyle{bebras-ch-deu}{«}[» ]{»}{“}[»› ]{”}
\\DeclareQuoteStyle{bebras-ch-fra}{«\\thinspace{}}[» ]{\\thinspace{}»}{“}[»\\thinspace{}› ]{”}
\\DeclareQuoteStyle{bebras-ch-ita}{«}[» ]{»}{“}[»› ]{”}
\\setquotestyle{bebras-ch-${langCode}}

\\usepackage{hyperref}
\\usepackage{graphicx}
\\usepackage{svg}
\\usepackage{wrapfig}

\\usepackage{enumitem}
\\setlist{nosep,itemsep=.5ex}

\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{2ex}
\\raggedbottom

\\usepackage{fancyhdr}
\\usepackage{lastpage}
\\pagestyle{fancy}

\\fancyhf{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0.4pt}
\\lfoot{\\scriptsize ${texEscapeChars(license.shortCopyright())}}
\\cfoot{\\scriptsize\\itshape ${texEscapeChars(metadata.id)} ${texEscapeChars(metadata.title)}}
\\rfoot{\\scriptsize Page~\\thepage{}/\\pageref*{LastPage}}

\\newcommand{\\taskGraphicsFolder}{..}

\\begin{document}
${taskTex}
\\end{document}
`

    }
}