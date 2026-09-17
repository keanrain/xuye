// Files.md LCS core excerpt, MIT, copyright (c) 2023 Artem Zakirullin.
// See ../../sources/FILESMD-LICENSE and ../../sources/provenance.json.
// This is a web-transcribed source excerpt, NOT the whole upstream merge package.
package mergecore

// backtrack is transcribed without algorithm changes from server/sync/merge.go.
func backtrack(lines1, lines2 []string, lcsLength [][]int, i, j int) []string {
	if i == 0 && j == 0 {
		return []string{}
	}
	if i == 0 {
		return append(backtrack(lines1, lines2, lcsLength, i, j-1), lines2[j-1])
	}
	if j == 0 {
		return append(backtrack(lines1, lines2, lcsLength, i-1, j), lines1[i-1])
	}
	if lines1[i-1] == lines2[j-1] {
		return append(backtrack(lines1, lines2, lcsLength, i-1, j-1), lines1[i-1])
	}
	if lcsLength[i-1][j] > lcsLength[i][j-1] {
		return append(backtrack(lines1, lines2, lcsLength, i-1, j), lines1[i-1])
	} else {
		return append(backtrack(lines1, lines2, lcsLength, i, j-1), lines2[j-1])
	}
}
