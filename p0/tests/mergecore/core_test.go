package mergecore

import (
 "strings"
 "testing"
)

// Test-only driver reproducing the DP part of upstream Merge.
// Journal header/emoji postprocessing is NOT included or tested.
// All fixtures exclude headers, where that upstream postprocessor changes nothing.
func plainFixtureMerge(s1,s2 string) string {
 if s1=="" {return s2}; if s2=="" {return s1}
 lines1,lines2:=strings.Split(s1,"\n"),strings.Split(s2,"\n")
 for _,line:=range append(append([]string{},lines1...),lines2...){
  if strings.HasPrefix(line,"#") {panic("fixture must not contain a journal header")}
 }
 table:=make([][]int,len(lines1)+1)
 for i:=range table {table[i]=make([]int,len(lines2)+1)}
 for i:=1;i<=len(lines1);i++ {for j:=1;j<=len(lines2);j++ {
  if lines1[i-1]==lines2[j-1] {table[i][j]=table[i-1][j-1]+1} else {table[i][j]=max(table[i-1][j],table[i][j-1])}
 }}
 return strings.Join(backtrack(lines1,lines2,table,len(lines1),len(lines2)),"\n")
}
func TestIdenticalLinesDeduplicated(t *testing.T){
 in:="line one\nline two";if got:=plainFixtureMerge(in,in);got!=in{t.Fatal(got)}
}
func TestEmptySideRetainsOther(t *testing.T){
 if got:=plainFixtureMerge("","content");got!="content"{t.Fatal(got)}
}
func TestCharacterizeTwoTaskStatesSurvive(t *testing.T){
 id:="<!-- personalos-task:33333333-3333-4333-8333-333333333333 -->"
 open,done:="- [ ] 验证内存 "+id,"- [x] 验证内存 "+id
 got:=plainFixtureMerge(open,done)
 t.Logf("characterization output (not desired product behavior): %q",got)
 if !strings.Contains(got,open)||!strings.Contains(got,done)||strings.Count(got,id)!=2{t.Fatal(got)}
}
func TestCharacterizeTwoRenamedTaskLinesSurvive(t *testing.T){
 id:="<!-- personalos-task:33333333-3333-4333-8333-333333333333 -->"
 a,b:="- [ ] 原标题 "+id,"- [ ] 新标题 "+id
 got:=plainFixtureMerge(a,b)
 if !strings.Contains(got,a)||!strings.Contains(got,b)||strings.Count(got,id)!=2{t.Fatal(got)}
 t.Logf("same ID appears twice: %q",got)
}
