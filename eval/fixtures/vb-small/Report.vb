Imports System.Collections.Generic
Imports System.Linq

Public Module Report
    Public Function FirstScore(items As List(Of Item)) As Integer
        Dim unused = NameOf(Item) ' operator, not a call — must emit NO edge
        Return items.First().Score()
    End Function
End Module
